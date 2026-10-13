-- 030_platform_signup_up.sql — Sprint 6.4: platform (tenants, lifecycle, trial, sandbox), public
-- signup, onboarding data package, implementation tracker. Protected (rule 13).
-- Additive, except: mail_outbox_demo_sink_only() and two import_runs CHECKs are replaced by
-- supersets (ADR 0003, "Zamena CHECK-a"); the ONLY tenant DELETE of the product
-- (platform_purge_sandbox, decision 6.4) is a SECURITY DEFINER function limited to expired demo
-- sandboxes.
--
-- Decisions (task 6.4): trial 14 days; trial and sandbox tenants send ONLY to the sink until
-- contract_signed_at is set. After the trial: read-only (never deleted). Sandbox: 7 days, then
-- read-only 7 days, then deleted by the platform job (audit under tenant #0).
--
-- Cross-tenant reads of the platform (tenant list) return NO business data (rule 32): name,
-- slug, lifecycle dates, number of users, last activity (time of the newest audit entry).

-- ============================================================================================
-- Tenant lifecycle
-- ============================================================================================
ALTER TABLE tenants
  ADD COLUMN lifecycle_status   text        NOT NULL DEFAULT 'active'
    CHECK (lifecycle_status IN ('sandbox', 'trial', 'active', 'suspended')),
  ADD COLUMN trial_ends_at      timestamptz,
  ADD COLUMN contract_signed_at timestamptz,
  ADD COLUMN sandbox_expires_at timestamptz,
  ADD COLUMN trial_reminded_at  timestamptz,
  ADD CONSTRAINT tenants_lifecycle_dates CHECK (
    (lifecycle_status <> 'trial' OR trial_ends_at IS NOT NULL)
    AND (lifecycle_status <> 'sandbox' OR (sandbox_expires_at IS NOT NULL AND is_demo)));

/** Writes allowed? false = read-only (trial or sandbox expired, or suspended). */
CREATE FUNCTION tenant_writable(t tenants) RETURNS boolean
  LANGUAGE sql STABLE
  SET search_path = pg_catalog
AS $$
  SELECT CASE t.lifecycle_status
           WHEN 'active' THEN true
           WHEN 'trial' THEN t.contract_signed_at IS NOT NULL OR t.trial_ends_at > now()
           WHEN 'sandbox' THEN t.sandbox_expires_at > now()
           ELSE false
         END;
$$;

-- Rule 24 + decision 6.4: a demo tenant, and a trial / sandbox tenant without a signed contract,
-- send e-mail ONLY to the sink (superset of 007: still checked on INSERT and on a transport change
-- only — the worker marks rows sent without access to tenants).
CREATE OR REPLACE FUNCTION mail_outbox_demo_sink_only() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.transport IS NOT DISTINCT FROM OLD.transport THEN
    RETURN NEW;
  END IF;
  IF NEW.transport <> 'sink' AND EXISTS (
    SELECT 1 FROM tenants t
    WHERE t.id = NEW.tenant_id
      AND (t.is_demo OR (t.lifecycle_status IN ('trial', 'sandbox') AND t.contract_signed_at IS NULL))
  ) THEN
    RAISE EXCEPTION 'mail_outbox: this tenant sends e-mail only to the sink (rule 24, trial / sandbox)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- ============================================================================================
-- Permission platform.manage (catalog; granted to owner of tenant #0 — the code also requires
-- the current tenant to be the platform operator)
-- ============================================================================================
INSERT INTO permissions (key) VALUES ('platform.manage') ON CONFLICT (key) DO NOTHING;
DO $$
DECLARE
  op uuid;
BEGIN
  PERFORM set_config('app.tenant_clock', 'on', true);
  SELECT id INTO op FROM tenants WHERE is_platform_operator;
  PERFORM set_config('app.tenant_clock', '', true);
  IF op IS NOT NULL THEN
    PERFORM set_config('app.tenant_id', op::text, true);
    INSERT INTO role_permissions (tenant_id, role_id, permission_id)
    SELECT op, r.id, p.id FROM roles r CROSS JOIN permissions p
    WHERE r.key = 'owner' AND p.key = 'platform.manage'
    ON CONFLICT DO NOTHING;
    PERFORM set_config('app.tenant_id', '', true);
  END IF;
END $$;

-- ============================================================================================
-- Implementation tracker (lives in tenant #0: the operator's own records about a client tenant)
-- ============================================================================================
CREATE TABLE implementation_trackers (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid        NOT NULL REFERENCES tenants (id),
  target_tenant_id   uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  lead_user_id       uuid,
  data_received_at   timestamptz,
  import_done_at     timestamptz,
  mailbox_done_at    timestamptz,
  bank_done_at       timestamptz,
  rules_done_at      timestamptz,
  training_done_at   timestamptz,
  go_live_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid,
  updated_by         uuid,
  CONSTRAINT implementation_trackers_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT implementation_trackers_one UNIQUE (tenant_id, target_tenant_id),
  CONSTRAINT implementation_trackers_lead FOREIGN KEY (tenant_id, lead_user_id) REFERENCES users (tenant_id, id)
);
CREATE TRIGGER implementation_trackers_updated_at BEFORE UPDATE ON implementation_trackers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================================================
-- Public signup requests (tenant #0) — the lead's data sealed with #0's integration key
-- ============================================================================================
CREATE TABLE signup_requests (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid        NOT NULL REFERENCES tenants (id),
  sandbox_tenant_id   uuid        REFERENCES tenants (id) ON DELETE SET NULL,
  company_enc         bytea       NOT NULL,
  company_key_version integer     NOT NULL CHECK (company_key_version >= 1),
  name_enc            bytea       NOT NULL,
  name_key_version    integer     NOT NULL CHECK (name_key_version >= 1),
  email_enc           bytea       NOT NULL,
  email_key_version   integer     NOT NULL CHECK (email_key_version >= 1),
  country_code        char(2)     NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  locale              text        NOT NULL CHECK (locale IN ('sr-Latn', 'en')),
  status              text        NOT NULL DEFAULT 'sandbox' CHECK (status IN ('sandbox', 'converted', 'expired')),
  converted_tenant_id uuid        REFERENCES tenants (id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT signup_requests_tenant_key UNIQUE (tenant_id, id)
);
CREATE TRIGGER signup_requests_updated_at BEFORE UPDATE ON signup_requests
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================================================
-- Onboarding data package (public page /onboarding/<token>, 72 h, rule 27) — in the client tenant
-- ============================================================================================
CREATE TABLE onboarding_packages (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  token_hash    bytea       NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  expires_at    timestamptz NOT NULL DEFAULT now() + interval '72 hours',
  received_at   timestamptz,
  -- Answers of the 10 policy questions: codes only (P0).
  answers       jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(answers) = 'object'),
  proposal      text        CHECK (proposal IN ('friendly', 'standard', 'strict', 'agro_seasonal')),
  files         integer     NOT NULL DEFAULT 0 CHECK (files BETWEEN 0 AND 20),
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  CONSTRAINT onboarding_packages_tenant_key UNIQUE (tenant_id, id)
);

-- Data from the package waits for the implementation team: status 'staged' (superset of 013).
ALTER TABLE import_runs DROP CONSTRAINT import_runs_status_check;
ALTER TABLE import_runs ADD CONSTRAINT import_runs_status_check
  CHECK (status IN ('staged', 'uploaded', 'validated', 'confirmed', 'completed', 'failed', 'cancelled', 'rolled_back'));
ALTER TABLE import_runs DROP CONSTRAINT import_runs_payload_lifetime;
ALTER TABLE import_runs ADD CONSTRAINT import_runs_payload_lifetime
  CHECK (payload_enc IS NULL OR status IN ('staged', 'uploaded', 'validated', 'confirmed'));

-- ============================================================================================
-- Platform functions (SECURITY DEFINER, owner = vigor_migrate). Every one checks that the
-- CURRENT tenant (SET LOCAL app.tenant_id) is the platform operator; the app checks
-- platform.manage before calling. Owner reads of other tenants open only inside them.
-- ============================================================================================
CREATE POLICY platform_write ON tenants FOR ALL TO vigor_migrate
  USING (current_setting('app.platform', true) = 'on')
  WITH CHECK (current_setting('app.platform', true) = 'on');

/** Id of tenant #0 (public signup and platform jobs need it before any tenant context). */
CREATE FUNCTION platform_operator_id() RETURNS uuid
  LANGUAGE plpgsql STABLE
  SECURITY DEFINER
  SET search_path = public, pg_catalog
AS $$
DECLARE
  op uuid;
BEGIN
  PERFORM set_config('app.tenant_clock', 'on', true);
  SELECT id INTO op FROM tenants WHERE is_platform_operator;
  PERFORM set_config('app.tenant_clock', '', true);
  RETURN op;
END $$;

CREATE FUNCTION platform_assert_operator() RETURNS uuid
  LANGUAGE plpgsql STABLE
  SECURITY DEFINER
  SET search_path = public, pg_catalog
AS $$
DECLARE
  cur uuid := app_tenant_id();
  op uuid;
BEGIN
  PERFORM set_config('app.tenant_clock', 'on', true);
  SELECT id INTO op FROM tenants WHERE is_platform_operator;
  PERFORM set_config('app.tenant_clock', '', true);
  IF cur IS NULL OR op IS NULL OR cur <> op THEN
    RAISE EXCEPTION 'platform functions run only in the platform operator tenant'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN op;
END $$;

CREATE FUNCTION platform_tenants()
  RETURNS TABLE (id uuid, slug text, display_name text, lifecycle_status text, is_demo boolean,
                 trial_ends_at timestamptz, sandbox_expires_at timestamptz,
                 contract_signed_at timestamptz, created_at timestamptz, users integer,
                 last_activity timestamptz)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_catalog
AS $$
DECLARE
  op uuid := platform_assert_operator();
  r record;
BEGIN
  PERFORM set_config('app.tenant_clock', 'on', true);
  FOR r IN SELECT t.* FROM tenants t WHERE NOT t.is_platform_operator ORDER BY t.created_at DESC LOOP
    PERFORM set_config('app.tenant_id', r.id::text, true);
    id := r.id; slug := r.slug; display_name := r.display_name; lifecycle_status := r.lifecycle_status;
    is_demo := r.is_demo; trial_ends_at := r.trial_ends_at; sandbox_expires_at := r.sandbox_expires_at;
    contract_signed_at := r.contract_signed_at; created_at := r.created_at;
    SELECT count(*)::int INTO users FROM users u WHERE u.status IN ('active', 'invited');
    SELECT max(a.occurred_at) INTO last_activity FROM audit_log a;
    RETURN NEXT;
  END LOOP;
  PERFORM set_config('app.tenant_id', op::text, true);
  PERFORM set_config('app.tenant_clock', '', true);
END $$;

/**
 * New tenant: tenants + settings + company (canonical legal entity) + the system roles of the
 * operator tenant with their grants (platform.manage never copied) + receivables defaults.
 * Returns the new tenant id; the caller (app) then invites the first owner in that tenant.
 */
CREATE FUNCTION platform_create_tenant(
  p_slug text, p_name text, p_country char(2), p_locale text, p_timezone text, p_currency char(3),
  p_policy text, p_lifecycle text, p_trial_days integer, p_is_demo boolean,
  p_company_name text, p_company_tax_id text)
  RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_catalog
AS $$
DECLARE
  op uuid := platform_assert_operator();
  t uuid := gen_random_uuid();
  le uuid;
BEGIN
  IF p_lifecycle NOT IN ('sandbox', 'trial', 'active') THEN
    RAISE EXCEPTION 'invalid lifecycle' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM set_config('app.platform', 'on', true);
  PERFORM set_config('app.tenant_id', t::text, true);
  INSERT INTO tenants (id, slug, display_name, is_demo, lifecycle_status, trial_ends_at, sandbox_expires_at)
  VALUES (t, p_slug, p_name, p_is_demo, p_lifecycle,
          CASE WHEN p_lifecycle = 'trial' THEN now() + make_interval(days => p_trial_days) END,
          CASE WHEN p_lifecycle = 'sandbox' THEN now() + make_interval(days => p_trial_days) END);
  INSERT INTO tenant_settings (tenant_id, default_locale, timezone, default_currency, country_code)
  VALUES (t, p_locale, p_timezone, p_currency, p_country);
  le := find_or_create_legal_entity(p_country, p_company_tax_id, p_company_name, p_timezone, NULL);
  INSERT INTO tenant_companies (tenant_id, legal_entity_id, display_name, is_default)
  VALUES (t, le, p_company_name, true);
  -- System roles and their grants, as in the operator tenant (seeded from docs/permissions.md).
  PERFORM set_config('app.tenant_id', op::text, true);
  CREATE TEMP TABLE IF NOT EXISTS _platform_roles (key text, is_system boolean, perm text) ON COMMIT DROP;
  DELETE FROM _platform_roles;
  INSERT INTO _platform_roles
  SELECT r.key, r.is_system, p.key FROM roles r
  LEFT JOIN role_permissions rp ON rp.role_id = r.id
  LEFT JOIN permissions p ON p.id = rp.permission_id
  WHERE r.is_system;
  PERFORM set_config('app.tenant_id', t::text, true);
  INSERT INTO roles (tenant_id, key, is_system)
  SELECT DISTINCT t, key, true FROM _platform_roles ON CONFLICT DO NOTHING;
  INSERT INTO role_permissions (tenant_id, role_id, permission_id)
  SELECT t, r.id, p.id FROM _platform_roles x
  JOIN roles r ON r.key = x.key JOIN permissions p ON p.key = x.perm
  WHERE x.perm IS NOT NULL AND x.perm <> 'platform.manage'
  ON CONFLICT DO NOTHING;
  -- The platform's service member of the tenant (disabled — it never signs in): the inviter of
  -- the first owner (user_invitations.invited_by is a member of the same tenant).
  INSERT INTO users (tenant_id, email, display_name, timezone, status)
  VALUES (t, 'platform-operator@collect.invalid', 'Platform', p_timezone, 'disabled');
  PERFORM provision_receivables_defaults();
  IF p_policy IS NOT NULL THEN
    UPDATE tenant_settings SET default_policy_code = p_policy
    WHERE EXISTS (SELECT 1 FROM code_lists WHERE list_key = 'collection_policy' AND code = p_policy);
  END IF;
  PERFORM set_config('app.platform', '', true);
  PERFORM set_config('app.tenant_id', op::text, true);
  RETURN t;
END $$;

/** Lifecycle change by the operator: convert a sandbox to a trial, activate, suspend, contract. */
CREATE FUNCTION platform_set_lifecycle(p_tenant uuid, p_status text, p_trial_days integer,
                                       p_contract_signed boolean)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_catalog
AS $$
DECLARE
  op uuid := platform_assert_operator();
BEGIN
  IF p_tenant = op THEN
    RAISE EXCEPTION 'the operator tenant has no lifecycle' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM set_config('app.platform', 'on', true);
  PERFORM set_config('app.tenant_id', p_tenant::text, true);
  UPDATE tenants SET
    lifecycle_status = coalesce(p_status, lifecycle_status),
    is_demo = CASE WHEN p_status = 'trial' AND lifecycle_status = 'sandbox' THEN false ELSE is_demo END,
    sandbox_expires_at = CASE WHEN p_status IN ('trial', 'active') THEN NULL ELSE sandbox_expires_at END,
    trial_ends_at = CASE WHEN p_status = 'trial' THEN now() + make_interval(days => coalesce(p_trial_days, 14))
                         WHEN p_status = 'active' THEN NULL ELSE trial_ends_at END,
    contract_signed_at = CASE WHEN p_contract_signed THEN coalesce(contract_signed_at, now()) ELSE contract_signed_at END,
    updated_at = now()
  WHERE id = p_tenant AND NOT is_platform_operator;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown tenant' USING ERRCODE = 'no_data_found';
  END IF;
  PERFORM set_config('app.platform', '', true);
  PERFORM set_config('app.tenant_id', op::text, true);
END $$;

/** Per-tenant feature flag (rule 31: the platform flag must be on — feature_flags trigger). */
CREATE FUNCTION platform_set_flag(p_tenant uuid, p_flag text, p_enabled boolean, p_user uuid)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_catalog
AS $$
DECLARE
  op uuid := platform_assert_operator();
BEGIN
  PERFORM set_config('app.tenant_id', p_tenant::text, true);
  INSERT INTO feature_flags (tenant_id, flag_key, enabled, enabled_by, enabled_at)
  VALUES (p_tenant, p_flag, p_enabled, CASE WHEN p_enabled THEN p_user END, CASE WHEN p_enabled THEN now() END)
  ON CONFLICT (tenant_id, flag_key) DO UPDATE SET enabled = EXCLUDED.enabled,
    enabled_by = EXCLUDED.enabled_by, enabled_at = EXCLUDED.enabled_at, updated_at = now();
  PERFORM set_config('app.tenant_id', op::text, true);
END $$;

/** Flags of one client tenant (key, enabled) — for the operator's switches. */
CREATE FUNCTION platform_tenant_flags(p_tenant uuid)
  RETURNS TABLE (flag_key text, platform_enabled boolean, enabled boolean)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_catalog
AS $$
DECLARE
  op uuid := platform_assert_operator();
BEGIN
  PERFORM set_config('app.tenant_id', p_tenant::text, true);
  RETURN QUERY
    SELECT p.key, p.enabled, coalesce(f.enabled, false)
    FROM platform_feature_flags p LEFT JOIN feature_flags f ON f.flag_key = p.key
    ORDER BY p.key;
  PERFORM set_config('app.tenant_id', op::text, true);
END $$;

/** Trials ending in 3 days not reminded yet → marked reminded, returned once (operator job). */
CREATE FUNCTION platform_trials_to_remind()
  RETURNS TABLE (id uuid, display_name text, trial_ends_at timestamptz)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_catalog
AS $$
DECLARE
  op uuid := platform_assert_operator();
  r record;
BEGIN
  PERFORM set_config('app.tenant_clock', 'on', true);
  FOR r IN SELECT t.id, t.display_name, t.trial_ends_at FROM tenants t
           WHERE t.lifecycle_status = 'trial' AND t.contract_signed_at IS NULL AND t.trial_reminded_at IS NULL
             AND t.trial_ends_at BETWEEN now() AND now() + interval '3 days' LOOP
    PERFORM set_config('app.platform', 'on', true);
    PERFORM set_config('app.tenant_id', r.id::text, true);
    UPDATE tenants SET trial_reminded_at = now() WHERE tenants.id = r.id;
    id := r.id; display_name := r.display_name; trial_ends_at := r.trial_ends_at;
    RETURN NEXT;
  END LOOP;
  PERFORM set_config('app.platform', '', true);
  PERFORM set_config('app.tenant_clock', '', true);
  PERFORM set_config('app.tenant_id', op::text, true);
END $$;

/** Expired sandboxes past their 7 read-only days (the worker purges them one by one). */
CREATE FUNCTION platform_purgeable_sandboxes() RETURNS SETOF uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_catalog
AS $$
BEGIN
  PERFORM set_config('app.tenant_clock', 'on', true);
  RETURN QUERY
    SELECT t.id FROM tenants t
    WHERE t.is_demo AND t.lifecycle_status = 'sandbox' AND NOT t.is_platform_operator
      AND t.sandbox_expires_at < now() - interval '7 days';
  PERFORM set_config('app.tenant_clock', '', true);
END $$;

/**
 * The ONLY tenant DELETE (decision 6.4): an expired demo sandbox, 7 days after it became
 * read-only. Every tenant table is emptied for that tenant (several passes follow the foreign
 * keys), user triggers (INSERT-only guards) are off for the duration, then the tenant row goes.
 * Returns the number of rows removed. The caller writes the audit entry under tenant #0.
 */
CREATE FUNCTION platform_purge_sandbox(p_tenant uuid) RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_catalog
AS $$
DECLARE
  ok boolean;
  tbl record;
  removed integer := 0;
  n integer;
  remaining integer;
  pass integer := 0;
BEGIN
  PERFORM set_config('app.tenant_clock', 'on', true);
  SELECT t.is_demo AND t.lifecycle_status = 'sandbox' AND NOT t.is_platform_operator
         AND t.sandbox_expires_at < now() - interval '7 days'
    INTO ok FROM tenants t WHERE t.id = p_tenant;
  PERFORM set_config('app.tenant_clock', '', true);
  IF NOT coalesce(ok, false) THEN
    RAISE EXCEPTION 'only an expired demo sandbox can be deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM set_config('app.tenant_id', p_tenant::text, true);
  FOR tbl IN SELECT c.table_name FROM information_schema.columns c
             JOIN information_schema.tables x ON x.table_schema = c.table_schema AND x.table_name = c.table_name
             WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' AND x.table_type = 'BASE TABLE'
               AND c.table_name <> 'tenants' LOOP
    -- INSERT-only tables have no DELETE policy: the owner steps out of FORCE RLS for this
    -- transaction only (the DELETE below names the tenant explicitly).
    EXECUTE format('ALTER TABLE %I DISABLE TRIGGER USER, NO FORCE ROW LEVEL SECURITY', tbl.table_name);
  END LOOP;
  LOOP
    pass := pass + 1;
    remaining := 0;
    FOR tbl IN SELECT c.table_name FROM information_schema.columns c
               JOIN information_schema.tables x ON x.table_schema = c.table_schema AND x.table_name = c.table_name
               WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' AND x.table_type = 'BASE TABLE'
                 AND c.table_name <> 'tenants' LOOP
      BEGIN
        EXECUTE format('DELETE FROM %I WHERE tenant_id = $1', tbl.table_name) USING p_tenant;
        GET DIAGNOSTICS n = ROW_COUNT;
        removed := removed + n;
      EXCEPTION WHEN foreign_key_violation THEN
        remaining := remaining + 1;
      END;
    END LOOP;
    EXIT WHEN remaining = 0 OR pass >= 25;
  END LOOP;
  FOR tbl IN SELECT c.table_name FROM information_schema.columns c
             JOIN information_schema.tables x ON x.table_schema = c.table_schema AND x.table_name = c.table_name
             WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' AND x.table_type = 'BASE TABLE'
               AND c.table_name <> 'tenants' LOOP
    EXECUTE format('ALTER TABLE %I ENABLE TRIGGER USER, FORCE ROW LEVEL SECURITY', tbl.table_name);
  END LOOP;
  IF remaining > 0 THEN
    RAISE EXCEPTION 'sandbox purge left rows behind' USING ERRCODE = 'foreign_key_violation';
  END IF;
  PERFORM set_config('app.platform', 'on', true);
  DELETE FROM pii_field_registry WHERE table_name = 'custom_field_values' AND column_name LIKE 'cf:%'
    AND NOT EXISTS (SELECT 1 FROM custom_field_definitions d WHERE 'cf:' || d.id::text = column_name);
  DELETE FROM tenants WHERE id = p_tenant;
  PERFORM set_config('app.platform', '', true);
  PERFORM set_config('app.tenant_id', '', true);
  RETURN removed + 1;
END $$;

/** Onboarding package by token hash (public page; rule 27): id, tenant, name, state. */
CREATE FUNCTION onboarding_package_lookup(p_hash bytea)
  RETURNS TABLE (id uuid, tenant_id uuid, tenant_name text, expires_at timestamptz,
                 received_at timestamptz, files integer, answered boolean)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_catalog
AS $$
DECLARE
  r record;
BEGIN
  PERFORM set_config('app.tenant_clock', 'on', true);
  FOR r IN SELECT t.id AS tid FROM tenants t LOOP
    PERFORM set_config('app.tenant_id', r.tid::text, true);
    RETURN QUERY
      SELECT o.id, o.tenant_id, t.display_name, o.expires_at, o.received_at, o.files, o.answers <> '{}'::jsonb
      FROM onboarding_packages o JOIN tenants t ON t.id = o.tenant_id
      WHERE o.token_hash = p_hash;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
  PERFORM set_config('app.tenant_clock', '', true);
END $$;

/** Receipt of client data = start of the SLA clock in the operator's implementation tracker. */
CREATE FUNCTION platform_mark_data_received(p_tenant uuid) RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_catalog
AS $$
DECLARE
  op uuid;
  back text := current_setting('app.tenant_id', true);
BEGIN
  PERFORM set_config('app.tenant_clock', 'on', true);
  SELECT id INTO op FROM tenants WHERE is_platform_operator;
  PERFORM set_config('app.tenant_clock', '', true);
  IF op IS NULL THEN RETURN; END IF;
  PERFORM set_config('app.tenant_id', op::text, true);
  INSERT INTO implementation_trackers (tenant_id, target_tenant_id, data_received_at)
  VALUES (op, p_tenant, now())
  ON CONFLICT (tenant_id, target_tenant_id) DO UPDATE
    SET data_received_at = coalesce(implementation_trackers.data_received_at, now());
  PERFORM set_config('app.tenant_id', coalesce(back, ''), true);
END $$;

REVOKE ALL ON FUNCTION platform_operator_id(), platform_assert_operator(), platform_tenants(), platform_create_tenant(text, text, char, text, text, char, text, text, integer, boolean, text, text),
  platform_set_lifecycle(uuid, text, integer, boolean), platform_set_flag(uuid, text, boolean, uuid),
  platform_tenant_flags(uuid), platform_trials_to_remind(), platform_purgeable_sandboxes(),
  platform_purge_sandbox(uuid), onboarding_package_lookup(bytea), platform_mark_data_received(uuid),
  tenant_writable(tenants) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_operator_id() TO vigor_app, vigor_worker;
GRANT EXECUTE ON FUNCTION platform_tenants(), platform_create_tenant(text, text, char, text, text, char, text, text, integer, boolean, text, text),
  platform_set_lifecycle(uuid, text, integer, boolean), platform_set_flag(uuid, text, boolean, uuid),
  platform_tenant_flags(uuid), platform_trials_to_remind(), onboarding_package_lookup(bytea),
  platform_mark_data_received(uuid), tenant_writable(tenants) TO vigor_app;
GRANT EXECUTE ON FUNCTION platform_purgeable_sandboxes(), platform_purge_sandbox(uuid) TO vigor_worker;

-- Platform flag: Pipedrive lead from a public signup (off until the n8n workflow exists).
INSERT INTO platform_feature_flags (key, enabled) VALUES ('signup.pipedrive_lead', false)
ON CONFLICT (key) DO NOTHING;

-- ============================================================================================
-- RLS, grants, PII registry
-- ============================================================================================
ALTER TABLE implementation_trackers ENABLE ROW LEVEL SECURITY;
ALTER TABLE implementation_trackers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON implementation_trackers
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE signup_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE signup_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON signup_requests
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE onboarding_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE onboarding_packages FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON onboarding_packages
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
REVOKE DELETE, TRUNCATE ON implementation_trackers, signup_requests FROM vigor_app;
REVOKE TRUNCATE ON onboarding_packages FROM vigor_app;

INSERT INTO pii_field_registry (table_name, column_name, pii_class, encrypted, purpose)
VALUES ('signup_requests', 'company_enc', 'P1', true, 'company of a public signup (sealed, #0 key)'),
       ('signup_requests', 'name_enc', 'P1', true, 'contact name of a public signup (sealed)'),
       ('signup_requests', 'email_enc', 'P1', true, 'e-mail of a public signup (sealed)');
INSERT INTO pii_field_registry (table_name, column_name, pii_class, purpose)
SELECT c.table_name, c.column_name, 'P0', 'not personal data (registered by 030)'
FROM information_schema.columns c
WHERE c.table_schema = 'public'
  AND (c.table_name IN ('implementation_trackers', 'onboarding_packages')
       OR (c.table_name = 'signup_requests' AND c.column_name NOT IN ('company_enc', 'name_enc', 'email_enc'))
       OR (c.table_name = 'tenants' AND c.column_name IN ('lifecycle_status', 'trial_ends_at', 'contract_signed_at',
                                                          'sandbox_expires_at', 'trial_reminded_at')));
