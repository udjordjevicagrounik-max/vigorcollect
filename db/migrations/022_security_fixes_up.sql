-- 022_security_fixes_up.sql — fixes from docs/security-review-2026-10-13.md (session 5.0).
-- Additive (rule 15): functions are replaced with the same signatures, new objects are added,
-- nothing is dropped that holds data. Protected (rule 13).

-- ============================================================================================
-- S-05: job_health() without escalation
-- ============================================================================================
-- Before: SECURITY DEFINER owned by vigor_migrate (owner of every table) reading pgboss.job,
-- which vigor_worker owns and may replace with a view that calls its own function — that code
-- then ran as vigor_migrate on the next /health. Now job_health() is SECURITY INVOKER and only
-- calls pgboss.job_health(), a DEFINER function the worker installs at start and OWNS ITSELF
-- (src/server/jobs/worker.ts installJobHealth): whatever the worker puts behind pgboss.job runs
-- as vigor_worker, never as a more privileged role. vigor_app may call that one function; it
-- still has no privilege on any pg-boss table. The worker revokes its old SELECT grant to
-- vigor_migrate at start.

GRANT USAGE ON SCHEMA pgboss TO vigor_app;

CREATE OR REPLACE FUNCTION job_health()
  RETURNS TABLE (pending integer, failed integer, oldest_pending_seconds integer,
                 last_retention_at timestamptz)
  LANGUAGE plpgsql STABLE
  SECURITY INVOKER
  SET search_path = pg_catalog
AS $$
BEGIN
  RETURN QUERY EXECUTE 'SELECT * FROM pgboss.job_health()';
EXCEPTION WHEN undefined_function OR undefined_table OR insufficient_privilege
               OR invalid_schema_name THEN
  -- Before the first worker start the function does not exist yet.
  RETURN QUERY SELECT NULL::int, NULL::int, NULL::int, NULL::timestamptz;
END $$;

REVOKE ALL ON FUNCTION job_health() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION job_health() TO vigor_app, vigor_worker;

-- ============================================================================================
-- S-09: claim a mail BEFORE it is handed to n8n
-- ============================================================================================
-- The dispatcher used to POST inside the tenant transaction and commit 'sent' at the end; any
-- later error rolled the whole batch back and the next run sent the same mails again. Now each
-- mail is claimed in its own COMMITTED transaction first: the claim moves next_attempt_at to the
-- end of a lease, so neither a second worker nor the next run picks it up while it is in
-- flight. If the process dies after the POST, the mail is retried only after the lease, with
-- the same Idempotency-Key (= mail_outbox.id), which the n8n template deduplicates.
CREATE FUNCTION mail_outbox_claim(p_id uuid, p_due timestamptz, p_lease_until timestamptz)
  RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_catalog, pg_temp
AS $$
BEGIN
  IF app_tenant_id() IS NULL THEN
    RAISE EXCEPTION 'mail_outbox_claim requires a tenant context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_lease_until <= p_due THEN
    RAISE EXCEPTION 'mail_outbox_claim: the lease must end after the due time' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE public.mail_outbox
  SET next_attempt_at = p_lease_until, status_reason = 'dispatch.claimed'
  WHERE id = p_id AND tenant_id = app_tenant_id() AND transport = 'integration'
    AND status = 'pending' AND coalesce(next_attempt_at, p_due) <= p_due;
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION mail_outbox_claim(uuid, timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mail_outbox_claim(uuid, timestamptz, timestamptz) TO vigor_app;

-- ============================================================================================
-- S-06 (and S-16): an API key has a data scope; wider than OWN needs a second administrator
-- ============================================================================================
-- Before: every key acted with ORGANIZATION scope, whatever scope its creator had. Now a key is
-- OWN (scoped data stays out of reach — a key owns nothing) or ORGANIZATION; ORGANIZATION only
-- if the creator holds every chosen permission with ORGANIZATION, and — except in the
-- one-administrator bootstrap tenant — only after another administrator approves
-- (approval_requests 'api_key.scope'). Until then activated_at IS NULL and the key does not
-- authenticate. Keys issued before 022 keep working as they did (ORGANIZATION, active).
ALTER TABLE api_keys
  ADD COLUMN scope text NOT NULL DEFAULT 'ORGANIZATION' CHECK (scope IN ('OWN', 'ORGANIZATION')),
  ADD COLUMN activated_at timestamptz;
UPDATE api_keys SET activated_at = created_at;
ALTER TABLE api_keys ALTER COLUMN scope SET DEFAULT 'OWN';

INSERT INTO pii_field_registry (table_name, column_name, pii_class, purpose)
VALUES ('api_keys', 'scope', 'P0', 'not personal data (registered by 022)'),
       ('api_keys', 'activated_at', 'P0', 'not personal data (registered by 022)');

-- ============================================================================================
-- S-01: the app sees only the PUBLIC register data of a linked legal entity
-- ============================================================================================
-- legal_entities is the platform-wide canonical identity (ADR 0002): the same company in two
-- tenants is one row. A tenant linking a tax id another tenant entered first saw that row's
-- bookkeeping too — created_at (when the platform first knew the company), created_by,
-- updated_*, verification_status — i.e. "this company is already on the platform". Now
-- vigor_app holds SELECT only on the public register columns (column grants), reads them
-- through legal_entities_public (security_invoker: the link-based RLS still decides WHICH rows),
-- and find_or_create_legal_entity() answers the same way whether it found or created the row.
CREATE VIEW legal_entities_public WITH (security_invoker = true) AS
  SELECT id, country_code, tax_id, registration_number, legal_name, normalized_name, timezone,
         address_line1, address_line2, postal_code, city, region, address_country_code
  FROM legal_entities;
COMMENT ON VIEW legal_entities_public IS
  'Public register data of the legal entities linked to the current tenant (review S-01). The app reads only this.';

REVOKE SELECT ON legal_entities FROM vigor_app;
GRANT SELECT (id, country_code, tax_id, registration_number, legal_name, normalized_name, timezone,
              address_line1, address_line2, postal_code, city, region, address_country_code)
  ON legal_entities TO vigor_app;
REVOKE ALL ON legal_entities_public FROM PUBLIC;
GRANT SELECT ON legal_entities_public TO vigor_app;

-- Same body as 002, plus: a found row and a created row take the same path to the answer — the
-- id only, never which of the two happened (no error, no different timing branch the caller can
-- see through a second query; the bookkeeping columns are no longer readable at all).
CREATE OR REPLACE FUNCTION find_or_create_legal_entity(
  p_country_code         text,
  p_tax_id               text,
  p_legal_name           text,
  p_timezone             text,
  p_registration_number  text DEFAULT NULL
) RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF public.app_tenant_id() IS NULL THEN
    RAISE EXCEPTION 'find_or_create_legal_entity requires a tenant context'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_country_code IS NULL OR p_country_code !~ '^[A-Z]{2}$'
     OR p_tax_id IS NULL OR p_tax_id = '' OR p_tax_id <> pg_catalog.btrim(p_tax_id)
     OR p_legal_name IS NULL OR pg_catalog.btrim(p_legal_name) = ''
     OR p_timezone IS NULL OR p_timezone = '' THEN
    RAISE EXCEPTION 'find_or_create_legal_entity: invalid arguments'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  INSERT INTO public.legal_entities
    (country_code, tax_id, registration_number, legal_name, normalized_name, timezone)
  VALUES
    (p_country_code, p_tax_id, nullif(pg_catalog.btrim(p_registration_number), ''),
     pg_catalog.btrim(p_legal_name),
     pg_catalog.lower(pg_catalog.regexp_replace(pg_catalog.btrim(p_legal_name), '\s+', ' ', 'g')),
     p_timezone)
  ON CONFLICT (country_code, tax_id) DO NOTHING;

  -- One lookup for both cases (found / just created).
  SELECT le.id INTO STRICT v_id
  FROM public.legal_entities le
  WHERE le.country_code = p_country_code AND le.tax_id = p_tax_id;

  RETURN v_id;
END $$;

-- ============================================================================================
-- S-02: natural persons in the invoice import
-- ============================================================================================
-- Before: every imported customer went through find_or_create_legal_entity as a company. A
-- consumer whose personal id number was in the tax id column became a global legal_entities row
-- (name in plaintext) with is_natural_person = false — rule 19 (no automatic legal effect) and
-- rule 20 (personal data encrypted) silently off. Now the import classifies each party by the
-- identifier rules of its country (rule 25: per country, never in code) and an optional column
-- "natural person"; anything uncertain is NOT imported but becomes a reconciliation exception
-- 'review_required' for a person.
--   party_id_rules: {"natural_person": "<regex>", "company": "<regex>"} — regexes over the
--   trimmed identifier. A country without rules cannot be judged → review (unless the file says).
ALTER TABLE jurisdiction_profiles
  ADD COLUMN party_id_rules jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(party_id_rules) = 'object');
-- RS: JMBG (13 digits) = a natural person; PIB (9 digits) = a business subject.
UPDATE jurisdiction_profiles
SET party_id_rules = '{"natural_person": "^[0-9]{13}$", "company": "^[0-9]{9}$"}'::jsonb
WHERE country_code = 'RS';

-- New exception kind; the CHECK is replaced by a superset under the same name (ADR 0003,
-- "Zamena CHECK-a"), no data changes.
ALTER TABLE reconciliation_exceptions DROP CONSTRAINT reconciliation_exceptions_kind_check;
ALTER TABLE reconciliation_exceptions ADD CONSTRAINT reconciliation_exceptions_kind_check
  CHECK (kind IN ('paid_invoice_changed', 'total_changed', 'open_amount_increased',
                  'currency_changed', 'customer_changed', 'rollback_blocked', 'review_required'));

INSERT INTO pii_field_registry (table_name, column_name, pii_class, purpose)
VALUES ('jurisdiction_profiles', 'party_id_rules', 'P0', 'not personal data (registered by 022)');

-- ============================================================================================
-- S-03: credentials in schema auth are out of reach inside a tenant transaction; a session's
-- active tenant must be an active membership of its person
-- ============================================================================================
-- Better Auth 1.7.7 stores the session token as it is (it looks sessions up by the plaintext
-- token; hashing would mean replacing its session storage — rule 10). What changes instead:
--   1. vigor_app's policies on auth.* apply only OUTSIDE a tenant transaction
--      (app_tenant_id() IS NULL). Better Auth runs on its own pool and never sets a tenant, so it
--      is unaffected; every tenant route runs with SET LOCAL app.tenant_id (withTenant) — a query
--      bug or an injection there sees no session token, password hash or TOTP secret.
--   2. auth.session."activeTenantId" — the ONLY tenant source of withTenant() — is checked by
--      the database on every write: the person must be an ACTIVE member of that tenant. Before,
--      only the Better Auth hook checked it; a direct write could switch a session to any tenant.
ALTER POLICY app_all ON auth."user"
  USING (app_tenant_id() IS NULL) WITH CHECK (app_tenant_id() IS NULL);
ALTER POLICY app_all ON auth."session"
  USING (app_tenant_id() IS NULL) WITH CHECK (app_tenant_id() IS NULL);
ALTER POLICY app_all ON auth."account"
  USING (app_tenant_id() IS NULL) WITH CHECK (app_tenant_id() IS NULL);
ALTER POLICY app_all ON auth."verification"
  USING (app_tenant_id() IS NULL) WITH CHECK (app_tenant_id() IS NULL);
ALTER POLICY app_all ON auth."twoFactor"
  USING (app_tenant_id() IS NULL) WITH CHECK (app_tenant_id() IS NULL);
ALTER POLICY app_all ON auth."rateLimit"
  USING (app_tenant_id() IS NULL) WITH CHECK (app_tenant_id() IS NULL);

-- Runs as the owner (FORCE RLS applies): it opens the ONE tenant being checked for the duration
-- of a single EXISTS and restores the caller's setting before returning.
CREATE FUNCTION auth_session_active_tenant_guard() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  previous text;
  member boolean;
BEGIN
  IF NEW."activeTenantId" IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."activeTenantId" IS NOT DISTINCT FROM OLD."activeTenantId"
     AND NEW."userId" = OLD."userId" THEN
    RETURN NEW;
  END IF;
  previous := current_setting('app.tenant_id', true);
  PERFORM set_config('app.tenant_id', NEW."activeTenantId"::text, true);
  SELECT EXISTS (
    SELECT 1 FROM public.users u WHERE u.auth_user_id = NEW."userId" AND u.status = 'active'
  ) INTO member;
  PERFORM set_config('app.tenant_id', coalesce(previous, ''), true);
  IF NOT member THEN
    RAISE EXCEPTION 'auth.session: activeTenantId is not an active membership of this person'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION auth_session_active_tenant_guard() FROM PUBLIC;

CREATE TRIGGER session_active_tenant BEFORE INSERT OR UPDATE ON auth."session"
  FOR EACH ROW EXECUTE FUNCTION auth_session_active_tenant_guard();
