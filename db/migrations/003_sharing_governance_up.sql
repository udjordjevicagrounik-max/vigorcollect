-- 003_sharing_governance_up.sql — Schema v1, part 0.2c.
-- Consumers without canonical identity (ADR 0002, decision 4), tenant code lists and
-- translations (rule 17), external parties and access grants (rule 34), data source rights
-- (rule 35), maker-checker requests (rule 11), decisions with human approval for natural
-- persons (rule 19) and the INSERT-only export log (rule 12). NO financial tables.
-- Applied by scripts/migrate.sh as vigor_migrate in one transaction. Protected file (rule 13).
--
-- Conventions as in 001/002 (docs/schema-v1.md). request_id = the X-Request-Id correlation
-- (rule 23), uuid like audit_log.request_id.

-- ============================================================================================
-- Functions
-- ============================================================================================

-- Generic INSERT-only guard (export_log). audit_log keeps its own trigger untouched (rule 6).
CREATE FUNCTION block_mutation() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION '% is INSERT-only (% blocked)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END $$;

-- ============================================================================================
-- Consumers: natural persons without a canonical identity (ADR 0002, decision 4)
-- ============================================================================================

-- A consumer never gets a legal_entities row; its identity exists only encrypted on customers.
ALTER TABLE customers ALTER COLUMN legal_entity_id DROP NOT NULL;
ALTER TABLE customers ADD CONSTRAINT customers_identity_required
  CHECK (legal_entity_id IS NOT NULL OR is_natural_person);

-- ============================================================================================
-- code_lists + translations (rule 17: tenant-editable text lives in the database)
-- ============================================================================================

CREATE TABLE code_lists (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid        NOT NULL REFERENCES tenants (id),
  list_key       text        NOT NULL CHECK (list_key ~ '^[a-z][a-z0-9_]{1,62}$'),
  code           text        NOT NULL CHECK (code ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
  is_active      boolean     NOT NULL DEFAULT true,
  is_system      boolean     NOT NULL DEFAULT false,
  sort_order     integer     NOT NULL DEFAULT 0,
  -- Rule 31: a value that is only valid while a feature flag is on (e.g. settlement resolution).
  requires_flag  text        REFERENCES platform_feature_flags (key),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid,
  updated_by     uuid,
  CONSTRAINT code_lists_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT code_lists_code_per_list UNIQUE (tenant_id, list_key, code)
);

-- customers.segment_code → code list 'customer_segment' (composite FK through a constant
-- generated column; NULL segment = no check).
ALTER TABLE customers ADD COLUMN segment_list_key text
  GENERATED ALWAYS AS ('customer_segment') STORED;
ALTER TABLE customers ADD CONSTRAINT customers_segment
  FOREIGN KEY (tenant_id, segment_list_key, segment_code)
  REFERENCES code_lists (tenant_id, list_key, code);

-- Labels of tenant-editable things, per locale. entity_key = roles.key or '<list_key>.<code>'.
CREATE TABLE translations (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid        NOT NULL REFERENCES tenants (id),
  entity_type  text        NOT NULL CHECK (entity_type IN ('role', 'code_list')),
  entity_key   text        NOT NULL CHECK (entity_key ~ '^[a-z0-9][a-z0-9_.-]{0,126}$'),
  field        text        NOT NULL DEFAULT 'name' CHECK (field IN ('name', 'description')),
  locale       text        NOT NULL CHECK (locale ~ '^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2})?$'),
  text         text        NOT NULL CHECK (text <> ''),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid,
  updated_by   uuid,
  CONSTRAINT translations_unique UNIQUE (tenant_id, entity_type, entity_key, field, locale)
);

-- ============================================================================================
-- external_parties + access_grants (rule 34)
-- ============================================================================================

-- The tenant's directory of external parties. Existing here NEVER means access to data:
-- access exists only through an active, approved, unexpired access_grant.
CREATE TABLE external_parties (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid        NOT NULL REFERENCES tenants (id),
  party_type       text        NOT NULL CHECK (party_type IN ('LAW_FIRM', 'BROKER', 'INSURER', 'FACTOR',
                                                            'BANK', 'COLLECTION_AGENCY',
                                                            'OTHER_APPROVED_PARTNER')),
  display_name     text        NOT NULL CHECK (display_name <> ''),
  legal_entity_id  uuid        REFERENCES legal_entities (id),
  country_code     char(2)     NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  contract_ref     text        CHECK (contract_ref <> ''),
  dpa_signed_at    timestamptz,
  status           text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  updated_by       uuid,
  CONSTRAINT external_parties_tenant_key UNIQUE (tenant_id, id)
);

-- One resource per row (resource-scoped, never tenant-wide). grant_batch_id groups several
-- grants to the same party for a joint revocation. The recipient has NO database access until
-- V2 (separate service, rule 32). Maker ≠ checker; scope is frozen once decided.
CREATE TABLE access_grants (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid        NOT NULL REFERENCES tenants (id),
  external_party_id  uuid        NOT NULL,
  grant_batch_id     uuid,
  purpose            text        NOT NULL CHECK (purpose ~ '^[a-z][a-z0-9_]{1,62}$'),
  resource_type      text        NOT NULL CHECK (resource_type ~ '^[a-z][a-z0-9_]{1,62}$'),
  resource_id        uuid        NOT NULL,
  permission_keys    text[]      NOT NULL CHECK (cardinality(permission_keys) >= 1),
  valid_from         timestamptz NOT NULL,
  valid_until        timestamptz NOT NULL,
  status             text        NOT NULL DEFAULT 'pending'
                                 CHECK (status IN ('pending', 'active', 'rejected', 'revoked')),
  requested_by       uuid        NOT NULL,
  approved_by        uuid,
  approved_at        timestamptz,
  revoked_by         uuid,
  revoked_at         timestamptz,
  revoke_reason      text        CHECK (revoke_reason <> ''),
  request_id         uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid,
  updated_by         uuid,
  CONSTRAINT access_grants_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT access_grants_party
    FOREIGN KEY (tenant_id, external_party_id) REFERENCES external_parties (tenant_id, id),
  CONSTRAINT access_grants_requested_by FOREIGN KEY (tenant_id, requested_by) REFERENCES users (tenant_id, id),
  CONSTRAINT access_grants_approved_by FOREIGN KEY (tenant_id, approved_by) REFERENCES users (tenant_id, id),
  CONSTRAINT access_grants_revoked_by FOREIGN KEY (tenant_id, revoked_by) REFERENCES users (tenant_id, id),
  CONSTRAINT access_grants_period CHECK (valid_until > valid_from),
  CONSTRAINT access_grants_approval
    CHECK ((status IN ('active', 'revoked')) = (approved_by IS NOT NULL AND approved_at IS NOT NULL)),
  CONSTRAINT access_grants_four_eyes CHECK (approved_by IS NULL OR approved_by <> requested_by),
  CONSTRAINT access_grants_revocation
    CHECK ((status = 'revoked') = (revoked_by IS NOT NULL AND revoked_at IS NOT NULL
                                   AND revoke_reason IS NOT NULL))
);
CREATE INDEX access_grants_party_idx ON access_grants (tenant_id, external_party_id, status);
CREATE INDEX access_grants_resource_idx ON access_grants (tenant_id, resource_type, resource_id);
CREATE INDEX access_grants_batch_idx ON access_grants (tenant_id, grant_batch_id)
  WHERE grant_batch_id IS NOT NULL;

-- Every permission key must exist in the catalog; once decided, scope is frozen and status
-- moves only forward: pending → active | rejected, active → revoked. valid_until may only shrink.
CREATE FUNCTION access_grants_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM unnest(NEW.permission_keys) k
    WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.key = k)
  ) THEN
    RAISE EXCEPTION 'access_grants: unknown permission key' USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.status IN ('rejected', 'revoked') THEN
      RAISE EXCEPTION 'access_grants: % grant is final', OLD.status USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.status = 'active' AND NEW.status NOT IN ('active', 'revoked') THEN
      RAISE EXCEPTION 'access_grants: active grant can only be revoked' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.status <> 'pending' AND (
         NEW.external_party_id IS DISTINCT FROM OLD.external_party_id
      OR NEW.grant_batch_id IS DISTINCT FROM OLD.grant_batch_id
      OR NEW.purpose IS DISTINCT FROM OLD.purpose
      OR NEW.resource_type IS DISTINCT FROM OLD.resource_type
      OR NEW.resource_id IS DISTINCT FROM OLD.resource_id
      OR NEW.permission_keys IS DISTINCT FROM OLD.permission_keys
      OR NEW.valid_from IS DISTINCT FROM OLD.valid_from
      OR NEW.valid_until > OLD.valid_until
      OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
      OR NEW.approved_by IS DISTINCT FROM OLD.approved_by
      OR NEW.approved_at IS DISTINCT FROM OLD.approved_at) THEN
      RAISE EXCEPTION 'access_grants: scope of a decided grant is frozen' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- ============================================================================================
-- data_sources (rule 35) — rights default to the strictest value
-- ============================================================================================

CREATE TABLE data_sources (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid        NOT NULL REFERENCES tenants (id),
  name                   text        NOT NULL CHECK (name <> ''),
  source_type            text        NOT NULL CHECK (source_type ~ '^[A-Z][A-Z0-9_]{1,30}$'),
  provider               text        CHECK (provider <> ''),
  contract_ref           text        CHECK (contract_ref <> ''),
  contract_valid_until   date,
  may_display            boolean     NOT NULL DEFAULT false,
  may_store              boolean     NOT NULL DEFAULT false,
  retention_days         integer     NOT NULL DEFAULT 0 CHECK (retention_days >= 0),
  may_derive             boolean     NOT NULL DEFAULT false,
  may_redistribute       boolean     NOT NULL DEFAULT false,
  may_onward_share       boolean     NOT NULL DEFAULT false,
  delete_on_termination  boolean     NOT NULL DEFAULT true,
  status                 text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  created_by             uuid,
  updated_by             uuid,
  CONSTRAINT data_sources_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT data_sources_name_per_tenant UNIQUE (tenant_id, name),
  -- Retention without the right to store is meaningless; onward sharing implies redistribution.
  CONSTRAINT data_sources_retention_requires_store CHECK (retention_days = 0 OR may_store),
  CONSTRAINT data_sources_onward_requires_redistribute CHECK (NOT may_onward_share OR may_redistribute)
);

-- ============================================================================================
-- approval_requests — maker-checker (rule 11)
-- ============================================================================================

CREATE TABLE approval_requests (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid        NOT NULL REFERENCES tenants (id),
  action_type    text        NOT NULL CHECK (action_type ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  entity_type    text        NOT NULL CHECK (entity_type <> ''),
  entity_id      uuid,
  -- Proposed change: ids, P0 values or ciphertext only (ADR 0003).
  payload        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  status         text        NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'expired')),
  requested_by   uuid        NOT NULL,
  decided_by     uuid,
  decided_at     timestamptz,
  decision_note  text        CHECK (decision_note <> ''),
  expires_at     timestamptz,
  request_id     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid,
  updated_by     uuid,
  CONSTRAINT approval_requests_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT approval_requests_requested_by FOREIGN KEY (tenant_id, requested_by) REFERENCES users (tenant_id, id),
  CONSTRAINT approval_requests_decided_by FOREIGN KEY (tenant_id, decided_by) REFERENCES users (tenant_id, id),
  CONSTRAINT approval_requests_decision
    CHECK ((status IN ('approved', 'rejected')) = (decided_by IS NOT NULL AND decided_at IS NOT NULL)),
  CONSTRAINT approval_requests_four_eyes CHECK (decided_by IS NULL OR decided_by <> requested_by)
);
CREATE INDEX approval_requests_pending ON approval_requests (tenant_id, created_at) WHERE status = 'pending';
CREATE INDEX approval_requests_entity ON approval_requests (tenant_id, entity_type, entity_id);

-- Only pending requests change; a decided request is final and its content frozen.
CREATE FUNCTION approval_requests_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'approval_requests: % request is final', OLD.status USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.action_type IS DISTINCT FROM OLD.action_type
     OR NEW.entity_type IS DISTINCT FROM OLD.entity_type
     OR NEW.entity_id IS DISTINCT FROM OLD.entity_id
     OR NEW.payload IS DISTINCT FROM OLD.payload
     OR NEW.requested_by IS DISTINCT FROM OLD.requested_by THEN
    RAISE EXCEPTION 'approval_requests: request content is frozen' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- ============================================================================================
-- decisions — rule 19
-- ============================================================================================

-- A rule or AI may only PROPOSE. For a natural person, a decision with legal effect becomes
-- 'approved' only with a human approver (trigger — the CHECK cannot see customers).
CREATE TABLE decisions (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid        NOT NULL REFERENCES tenants (id),
  customer_id          uuid        NOT NULL,
  decision_type        text        NOT NULL CHECK (decision_type ~ '^[a-z][a-z0-9_]{1,62}$'),
  has_legal_effect     boolean     NOT NULL DEFAULT true,
  source               text        NOT NULL CHECK (source IN ('rule', 'ai', 'human')),
  source_ref           text        CHECK (source_ref <> ''),
  status               text        NOT NULL DEFAULT 'proposed'
                                   CHECK (status IN ('proposed', 'approved', 'rejected', 'superseded')),
  rationale            text        CHECK (rationale <> ''),
  proposed_by          uuid,
  approved_by          uuid,
  approved_at          timestamptz,
  approval_request_id  uuid,
  request_id           uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid,
  updated_by           uuid,
  CONSTRAINT decisions_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT decisions_customer FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
  CONSTRAINT decisions_proposed_by FOREIGN KEY (tenant_id, proposed_by) REFERENCES users (tenant_id, id),
  CONSTRAINT decisions_approved_by FOREIGN KEY (tenant_id, approved_by) REFERENCES users (tenant_id, id),
  CONSTRAINT decisions_approval_request
    FOREIGN KEY (tenant_id, approval_request_id) REFERENCES approval_requests (tenant_id, id),
  CONSTRAINT decisions_human_source CHECK ((source = 'human') = (proposed_by IS NOT NULL)),
  CONSTRAINT decisions_approval CHECK ((status IN ('approved', 'superseded')) = (approved_at IS NOT NULL)),
  CONSTRAINT decisions_four_eyes CHECK (approved_by IS NULL OR approved_by IS DISTINCT FROM proposed_by)
);
CREATE INDEX decisions_customer_idx ON decisions (tenant_id, customer_id, created_at);

CREATE FUNCTION decisions_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status IN ('rejected', 'superseded') THEN
    RAISE EXCEPTION 'decisions: % decision is final', OLD.status USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'approved' AND (
       NEW.status <> 'superseded'
    OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
    OR NEW.decision_type IS DISTINCT FROM OLD.decision_type
    OR NEW.has_legal_effect IS DISTINCT FROM OLD.has_legal_effect
    OR NEW.approved_by IS DISTINCT FROM OLD.approved_by
    OR NEW.approved_at IS DISTINCT FROM OLD.approved_at) THEN
    RAISE EXCEPTION 'decisions: approved decision can only be superseded' USING ERRCODE = 'check_violation';
  END IF;
  -- Rule 19: natural person + legal effect → approved only by a human.
  IF NEW.status = 'approved' AND NEW.has_legal_effect AND NEW.approved_by IS NULL AND EXISTS (
    SELECT 1 FROM customers c
    WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.customer_id AND c.is_natural_person
  ) THEN
    RAISE EXCEPTION 'decisions: legal effect on a natural person requires human approval'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- ============================================================================================
-- export_log — rule 12, INSERT-only
-- ============================================================================================

CREATE TABLE export_log (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid        NOT NULL REFERENCES tenants (id),
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  actor_type       text        NOT NULL CHECK (actor_type IN ('user', 'system', 'job', 'external_party')),
  actor_id         uuid,
  export_type      text        NOT NULL CHECK (export_type ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'),
  format           text        NOT NULL CHECK (format IN ('csv', 'xlsx', 'pdf', 'json')),
  purpose          text        NOT NULL CHECK (purpose ~ '^[a-z][a-z0-9_]{1,62}$'),
  row_count        integer     NOT NULL CHECK (row_count >= 0),
  -- Filter that produced the export: ids/P0 values only (ADR 0003).
  filters          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  file_sha256      bytea       CHECK (octet_length(file_sha256) = 32),
  access_grant_id  uuid,
  request_id       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  CONSTRAINT export_log_grant
    FOREIGN KEY (tenant_id, access_grant_id) REFERENCES access_grants (tenant_id, id)
);
CREATE INDEX export_log_occurred ON export_log (tenant_id, occurred_at);
CREATE INDEX export_log_grant_idx ON export_log (tenant_id, access_grant_id) WHERE access_grant_id IS NOT NULL;

CREATE TRIGGER export_log_no_update_delete
  BEFORE UPDATE OR DELETE ON export_log
  FOR EACH ROW EXECUTE FUNCTION block_mutation();
CREATE TRIGGER export_log_no_truncate
  BEFORE TRUNCATE ON export_log
  FOR EACH STATEMENT EXECUTE FUNCTION block_mutation();

-- ============================================================================================
-- Triggers
-- ============================================================================================

CREATE TRIGGER code_lists_updated_at BEFORE UPDATE ON code_lists
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER translations_updated_at BEFORE UPDATE ON translations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER external_parties_updated_at BEFORE UPDATE ON external_parties
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER access_grants_updated_at BEFORE UPDATE ON access_grants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER access_grants_guard BEFORE INSERT OR UPDATE ON access_grants
  FOR EACH ROW EXECUTE FUNCTION access_grants_guard();
CREATE TRIGGER data_sources_updated_at BEFORE UPDATE ON data_sources
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER approval_requests_updated_at BEFORE UPDATE ON approval_requests
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER approval_requests_guard BEFORE UPDATE ON approval_requests
  FOR EACH ROW EXECUTE FUNCTION approval_requests_guard();
CREATE TRIGGER decisions_updated_at BEFORE UPDATE ON decisions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER decisions_guard BEFORE INSERT OR UPDATE ON decisions
  FOR EACH ROW EXECUTE FUNCTION decisions_guard();

-- ============================================================================================
-- Row Level Security — ENABLE + FORCE on every table (owner included)
-- ============================================================================================

ALTER TABLE code_lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE code_lists FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON code_lists
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

ALTER TABLE translations ENABLE ROW LEVEL SECURITY;
ALTER TABLE translations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON translations
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

ALTER TABLE external_parties ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_parties FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON external_parties
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

-- Owner tenant only. The recipient party has no database access until V2 (rule 32).
ALTER TABLE access_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON access_grants
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

ALTER TABLE data_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_sources FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON data_sources
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

ALTER TABLE approval_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON approval_requests
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

ALTER TABLE decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE decisions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON decisions
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

-- export_log: read + append within the tenant, like audit_log.
ALTER TABLE export_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE export_log FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON export_log FOR SELECT USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_append ON export_log FOR INSERT WITH CHECK (tenant_id = app_tenant_id());

-- ============================================================================================
-- Grants for vigor_app
-- ============================================================================================

-- Code values are deactivated (is_active), never deleted — customers may reference them.
REVOKE DELETE, TRUNCATE ON code_lists FROM vigor_app;
REVOKE TRUNCATE ON translations FROM vigor_app;
-- Parties are deactivated via status; grants, requests and decisions are history (status only).
REVOKE DELETE, TRUNCATE ON external_parties, access_grants, data_sources,
  approval_requests, decisions FROM vigor_app;
-- Rule 12: export_log is INSERT-only.
REVOKE UPDATE, DELETE, TRUNCATE ON export_log FROM vigor_app;

-- ============================================================================================
-- PII registry (rule 20)
-- ============================================================================================

-- ADR 0002, decision 4: a sole trader is a registered business subject; its identity in
-- legal_entities comes from the public business register. Consumers never enter legal_entities.
UPDATE pii_field_registry SET exception_reason = 'sole trader: public business register'
WHERE table_name = 'legal_entities' AND conditional_pii_class IS NOT NULL;
UPDATE pii_field_registry SET exception_reason = 'sole trader: public business register'
WHERE table_name = 'tenant_companies' AND column_name = 'display_name';
-- Never holds a natural person's name: CHECK customers_name_protection forces NULL, the value
-- lives encrypted in display_name_enc.
UPDATE pii_field_registry SET exception_reason = 'NULL for natural persons (CHECK); value in display_name_enc'
WHERE table_name = 'customers' AND column_name = 'display_name';

INSERT INTO pii_field_registry
  (table_name, column_name, pii_class, conditional_on, conditional_pii_class, encrypted, exception_reason, purpose)
VALUES
  ('external_parties', 'display_name', 'P0', 'party is a sole practitioner', 'P1', false,
   'professional identity from a public register (bar, business register)', 'name of the external party'),
  ('access_grants', 'revoke_reason', 'P1', NULL, NULL, false,
   'internal business note; ids and reasons only, no personal data (UI hint)', 'why the grant was revoked'),
  ('approval_requests', 'payload', 'P2', NULL, NULL, false,
   'container: ids, P0 values or ciphertext only', 'proposed change awaiting the checker'),
  ('approval_requests', 'decision_note', 'P1', NULL, NULL, false,
   'internal business note; ids and reasons only, no personal data (UI hint)', 'checker''s note'),
  ('decisions', 'rationale', 'P1', NULL, NULL, false,
   'internal business note; ids and reasons only, no personal data (UI hint)', 'why the decision was proposed'),
  ('export_log', 'filters', 'P2', NULL, NULL, false,
   'container: ids, P0 values or ciphertext only', 'filter that produced the export'),
  ('translations', 'text', 'P0', NULL, NULL, false, NULL, 'tenant-editable label (role, code value)');

INSERT INTO pii_field_registry (table_name, column_name, pii_class, purpose)
SELECT c.table_name, c.column_name, 'P0', 'not personal data (registered by 003)'
FROM information_schema.columns c
WHERE c.table_schema = 'public'
  AND (c.table_name IN ('code_lists', 'translations', 'external_parties', 'access_grants',
                        'data_sources', 'approval_requests', 'decisions', 'export_log')
       OR (c.table_name, c.column_name) IN (('customers', 'segment_list_key')))
ON CONFLICT (table_name, column_name) DO NOTHING;
