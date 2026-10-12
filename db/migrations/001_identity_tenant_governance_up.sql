-- 001_identity_tenant_governance_up.sql — Schema v1, part 0.2a.
-- Platform reference data, canonical legal entities (rule 30), tenant base, identity/roles,
-- feature flags (rule 31) and governance (audit_log, domain_events). NO financial tables.
-- Applied by scripts/migrate.sh as vigor_migrate in one transaction. Protected file (rule 13).
--
-- Conventions (docs/schema-v1.md):
--   * uuid PK; created_at/updated_at timestamptz (UTC); created_by/updated_by = actor uuid
--     (user, system or job — no FK, the actor is not always a user).
--   * Every table: ENABLE + FORCE ROW LEVEL SECURITY (the owner vigor_migrate is subject to RLS).
--   * Tenant tables: tenant_id NOT NULL, policy tenant_id = app_tenant_id(), composite FKs
--     (tenant_id, x_id) so a row can never point at another tenant's row.
--   * Platform tables: no tenant_id; vigor_app may only SELECT (policy + REVOKE).
--   * vigor_app gets DML by default (db/init default privileges); this file REVOKEs what the app
--     must not do.
--   * Every column is registered in pii_field_registry (rule 20).

CREATE EXTENSION IF NOT EXISTS citext;

-- ============================================================================================
-- Functions
-- ============================================================================================

-- Current tenant from the transaction-local setting written by withTenant() (rule 2).
-- missing_ok = true: without SET LOCAL app.tenant_id this returns NULL, so every tenant policy
-- evaluates to NULL (= no rows) instead of raising.
CREATE FUNCTION app_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = pg_catalog
AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE FUNCTION set_updated_at() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- ============================================================================================
-- Platform tables (no tenant_id; app = read-only)
-- ============================================================================================

-- Country-dependent configuration (rule 25). "country_profiles" in rule 17 is this table (ADR 0002).
-- Legal/financial parameters (interest, fees, limitation, document templates) are added
-- additively in the sprint that first needs them.
CREATE TABLE jurisdiction_profiles (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  country_code      char(2)     NOT NULL UNIQUE CHECK (country_code ~ '^[A-Z]{2}$'),
  default_currency  char(3)     NOT NULL CHECK (default_currency ~ '^[A-Z]{3}$'),
  default_locale    text        NOT NULL CHECK (default_locale ~ '^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2})?$'),
  default_timezone  text        NOT NULL CHECK (default_timezone <> ''),
  fx_source         text        NOT NULL DEFAULT 'ECB' CHECK (fx_source ~ '^[A-Z]{2,10}$'),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid,
  updated_by        uuid
);

-- FX rates (rule 18). Written only by fxRatesJob (via the migrate/worker path, never the app).
-- valid_on is the local publication date of the source (rule 26), not an instant.
CREATE TABLE exchange_rates (
  id              uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  source          text           NOT NULL CHECK (source ~ '^[A-Z]{2,10}$'),
  base_currency   char(3)        NOT NULL CHECK (base_currency ~ '^[A-Z]{3}$'),
  quote_currency  char(3)        NOT NULL CHECK (quote_currency ~ '^[A-Z]{3}$'),
  rate            numeric(20,10) NOT NULL CHECK (rate > 0),
  valid_on        date           NOT NULL,
  fetched_at      timestamptz    NOT NULL DEFAULT now(),
  created_at      timestamptz    NOT NULL DEFAULT now(),
  updated_at      timestamptz    NOT NULL DEFAULT now(),
  created_by      uuid,
  updated_by      uuid,
  CONSTRAINT exchange_rates_pair_differs CHECK (base_currency <> quote_currency),
  CONSTRAINT exchange_rates_unique UNIQUE (source, base_currency, quote_currency, valid_on)
);

-- Rule 20: every column has a PII class. conditional_on/conditional_pii_class express
-- "P0 for a company, P1/P2 when the party is a natural person".
CREATE TABLE pii_field_registry (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  table_name             text        NOT NULL,
  column_name            text        NOT NULL,
  pii_class              text        NOT NULL CHECK (pii_class IN ('P0', 'P1', 'P2', 'P3')),
  conditional_on         text,
  conditional_pii_class  text        CHECK (conditional_pii_class IN ('P0', 'P1', 'P2', 'P3')),
  encrypted              boolean     NOT NULL DEFAULT false,
  purpose                text        NOT NULL CHECK (purpose <> ''),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  created_by             uuid,
  updated_by             uuid,
  CONSTRAINT pii_field_registry_unique UNIQUE (table_name, column_name),
  CONSTRAINT pii_field_registry_conditional_pair
    CHECK ((conditional_on IS NULL) = (conditional_pii_class IS NULL))
);

-- Permission catalog ('object.action'); the matrix lives in docs/permissions.md (rule 7).
CREATE TABLE permissions (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  key         text        NOT NULL UNIQUE CHECK (key ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  updated_by  uuid
);

-- Platform level of the two-level flags (rule 31): kill switch, set by the platform operator.
CREATE TABLE platform_feature_flags (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  key         text        NOT NULL UNIQUE CHECK (key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  enabled     boolean     NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  updated_by  uuid
);

-- Canonical legal identity (rule 30): global, NO tenant_id, NO financial data.
-- The same legal entity in two tenants' portfolios is ONE row.
CREATE TABLE legal_entities (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  country_code          char(2)     NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  tax_id                text        NOT NULL CHECK (tax_id <> ''),
  registration_number   text        CHECK (registration_number <> ''),
  legal_name            text        NOT NULL CHECK (legal_name <> ''),
  normalized_name       text        NOT NULL CHECK (normalized_name <> ''),
  verification_status   text        NOT NULL DEFAULT 'unverified'
                                    CHECK (verification_status IN ('unverified', 'verified', 'rejected')),
  timezone              text        NOT NULL CHECK (timezone <> ''),
  address_line1         text,
  address_line2         text,
  postal_code           text,
  city                  text,
  region                text,
  address_country_code  char(2)     CHECK (address_country_code ~ '^[A-Z]{2}$'),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid,
  updated_by            uuid,
  CONSTRAINT legal_entities_identity UNIQUE (country_code, tax_id)
);

-- ============================================================================================
-- Tenant tables (tenant_id NOT NULL; tenants itself is keyed by id)
-- ============================================================================================

CREATE TABLE tenants (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                  text        NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  display_name          text        NOT NULL CHECK (display_name <> ''),
  status                text        NOT NULL DEFAULT 'active'
                                    CHECK (status IN ('active', 'suspended', 'closed')),
  is_platform_operator  boolean     NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid,
  updated_by            uuid
);
-- Exactly one tenant #0 (platform operator); platform actions are audited under it (ADR 0002).
CREATE UNIQUE INDEX tenants_single_platform_operator ON tenants (is_platform_operator)
  WHERE is_platform_operator;

CREATE TABLE tenant_settings (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid        NOT NULL UNIQUE REFERENCES tenants (id),
  default_locale    text        NOT NULL DEFAULT 'en'
                                CHECK (default_locale ~ '^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2})?$'),
  timezone          text        NOT NULL CHECK (timezone <> ''),
  default_currency  char(3)     NOT NULL CHECK (default_currency ~ '^[A-Z]{3}$'),
  country_code      char(2)     NOT NULL REFERENCES jurisdiction_profiles (country_code),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid,
  updated_by        uuid
);

-- The tenant's own companies, linked to the canonical identity (rule 30).
CREATE TABLE tenant_companies (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid        NOT NULL REFERENCES tenants (id),
  legal_entity_id  uuid        NOT NULL REFERENCES legal_entities (id),
  display_name     text        NOT NULL CHECK (display_name <> ''),
  is_default       boolean     NOT NULL DEFAULT false,
  status           text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  updated_by       uuid,
  CONSTRAINT tenant_companies_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT tenant_companies_entity_once UNIQUE (tenant_id, legal_entity_id)
);
CREATE UNIQUE INDEX tenant_companies_single_default ON tenant_companies (tenant_id) WHERE is_default;

-- Tenant membership of a person. auth_user_id bridges to Better Auth (schema `auth`, task 1.3).
CREATE TABLE users (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid        NOT NULL REFERENCES tenants (id),
  auth_user_id  uuid,
  email         citext      NOT NULL CHECK (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  display_name  text        NOT NULL CHECK (display_name <> ''),
  locale        text        NOT NULL DEFAULT 'en'
                            CHECK (locale ~ '^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2})?$'),
  timezone      text        NOT NULL CHECK (timezone <> ''),
  status        text        NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'disabled')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  updated_by    uuid,
  CONSTRAINT users_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT users_email_per_tenant UNIQUE (tenant_id, email),
  CONSTRAINT users_auth_user_per_tenant UNIQUE (tenant_id, auth_user_id)
);

-- Role names are tenant-editable text → translations (0.2b), keyed by roles.key (rule 17).
CREATE TABLE roles (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid        NOT NULL REFERENCES tenants (id),
  key         text        NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{1,62}$'),
  is_system   boolean     NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  updated_by  uuid,
  CONSTRAINT roles_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT roles_key_per_tenant UNIQUE (tenant_id, key)
);

CREATE TABLE role_permissions (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid        NOT NULL REFERENCES tenants (id),
  role_id        uuid        NOT NULL,
  permission_id  uuid        NOT NULL REFERENCES permissions (id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid,
  updated_by     uuid,
  CONSTRAINT role_permissions_role FOREIGN KEY (tenant_id, role_id) REFERENCES roles (tenant_id, id),
  CONSTRAINT role_permissions_unique UNIQUE (tenant_id, role_id, permission_id)
);

CREATE TABLE user_roles (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid        NOT NULL REFERENCES tenants (id),
  user_id     uuid        NOT NULL,
  role_id     uuid        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  updated_by  uuid,
  CONSTRAINT user_roles_user FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id),
  CONSTRAINT user_roles_role FOREIGN KEY (tenant_id, role_id) REFERENCES roles (tenant_id, id),
  CONSTRAINT user_roles_unique UNIQUE (tenant_id, user_id, role_id)
);

-- Tenant level of the two-level flags (rule 31). Effective state = platform AND tenant.
CREATE TABLE feature_flags (
  id                         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                  uuid        NOT NULL REFERENCES tenants (id),
  flag_key                   text        NOT NULL REFERENCES platform_feature_flags (key),
  enabled                    boolean     NOT NULL DEFAULT false,
  enabled_by                 uuid,
  enabled_at                 timestamptz,
  legal_basis_confirmed_at   timestamptz,
  jurisdiction_country_code  char(2)     REFERENCES jurisdiction_profiles (country_code),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  created_by                 uuid,
  updated_by                 uuid,
  CONSTRAINT feature_flags_unique UNIQUE (tenant_id, flag_key),
  CONSTRAINT feature_flags_enabled_attribution
    CHECK (NOT enabled OR (enabled_by IS NOT NULL AND enabled_at IS NOT NULL)),
  -- Rule 31: a settlement flag is switched on only with a confirmed legal basis and jurisdiction.
  CONSTRAINT feature_flags_settlement_prerequisites
    CHECK (NOT enabled OR flag_key NOT LIKE 'settlement.%'
           OR (legal_basis_confirmed_at IS NOT NULL AND jurisdiction_country_code IS NOT NULL))
);

-- Rule 31: a tenant flag cannot be on while the platform flag is off.
CREATE FUNCTION feature_flags_require_platform() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
BEGIN
  IF NEW.enabled AND NOT EXISTS (
    SELECT 1 FROM platform_feature_flags p WHERE p.key = NEW.flag_key AND p.enabled
  ) THEN
    RAISE EXCEPTION 'feature flag % is disabled at platform level', NEW.flag_key
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- ============================================================================================
-- Governance
-- ============================================================================================

-- Rule 6: INSERT-only. Platform actions are recorded under tenant #0 (ADR 0002).
-- Immutable rows → created_at only (no updated_at/updated_by).
CREATE TABLE audit_log (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid        NOT NULL REFERENCES tenants (id),
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  actor_type   text        NOT NULL CHECK (actor_type IN ('user', 'system', 'job', 'ai')),
  actor_id     uuid,
  action       text        NOT NULL CHECK (action ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  entity_type  text        NOT NULL CHECK (entity_type <> ''),
  entity_id    uuid,
  before       jsonb,
  after        jsonb,
  request_id   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid
);
CREATE INDEX audit_log_entity ON audit_log (tenant_id, entity_type, entity_id, occurred_at);

CREATE FUNCTION audit_log_block_mutation() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is INSERT-only (% blocked)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE TRIGGER audit_log_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_block_mutation();
CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_block_mutation();

-- Outbox for pg-boss. The app only appends; status columns are advanced by the worker role
-- (vigor_worker, task 1.5 — ADR 0002 "Otvoreno").
CREATE TABLE domain_events (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid        NOT NULL REFERENCES tenants (id),
  event_type      text        NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  aggregate_type  text        NOT NULL CHECK (aggregate_type <> ''),
  aggregate_id    uuid,
  payload         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  status          text        NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending', 'processing', 'processed', 'failed')),
  attempts        integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error      text,
  processed_at    timestamptz,
  request_id      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  updated_by      uuid,
  CONSTRAINT domain_events_processed_at CHECK ((status = 'processed') = (processed_at IS NOT NULL))
);
CREATE INDEX domain_events_pending ON domain_events (occurred_at) WHERE status = 'pending';
CREATE INDEX domain_events_aggregate ON domain_events (tenant_id, aggregate_type, aggregate_id);

-- ============================================================================================
-- updated_at triggers
-- ============================================================================================

CREATE TRIGGER jurisdiction_profiles_updated_at BEFORE UPDATE ON jurisdiction_profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER exchange_rates_updated_at BEFORE UPDATE ON exchange_rates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER pii_field_registry_updated_at BEFORE UPDATE ON pii_field_registry
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER permissions_updated_at BEFORE UPDATE ON permissions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER platform_feature_flags_updated_at BEFORE UPDATE ON platform_feature_flags
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER legal_entities_updated_at BEFORE UPDATE ON legal_entities
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER tenants_updated_at BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER tenant_settings_updated_at BEFORE UPDATE ON tenant_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER tenant_companies_updated_at BEFORE UPDATE ON tenant_companies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER roles_updated_at BEFORE UPDATE ON roles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER role_permissions_updated_at BEFORE UPDATE ON role_permissions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER user_roles_updated_at BEFORE UPDATE ON user_roles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER feature_flags_updated_at BEFORE UPDATE ON feature_flags
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER feature_flags_platform_check BEFORE INSERT OR UPDATE ON feature_flags
  FOR EACH ROW EXECUTE FUNCTION feature_flags_require_platform();
CREATE TRIGGER domain_events_updated_at BEFORE UPDATE ON domain_events
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================================================
-- Row Level Security — ENABLE + FORCE on every table (owner included)
-- ============================================================================================

-- Platform tables: app reads, vigor_migrate maintains.
ALTER TABLE jurisdiction_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE jurisdiction_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY app_read ON jurisdiction_profiles FOR SELECT TO vigor_app USING (true);
CREATE POLICY migrate_all ON jurisdiction_profiles TO vigor_migrate USING (true) WITH CHECK (true);

ALTER TABLE exchange_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE exchange_rates FORCE ROW LEVEL SECURITY;
CREATE POLICY app_read ON exchange_rates FOR SELECT TO vigor_app USING (true);
CREATE POLICY migrate_all ON exchange_rates TO vigor_migrate USING (true) WITH CHECK (true);

ALTER TABLE pii_field_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE pii_field_registry FORCE ROW LEVEL SECURITY;
CREATE POLICY app_read ON pii_field_registry FOR SELECT TO vigor_app USING (true);
CREATE POLICY migrate_all ON pii_field_registry TO vigor_migrate USING (true) WITH CHECK (true);

ALTER TABLE permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE permissions FORCE ROW LEVEL SECURITY;
CREATE POLICY app_read ON permissions FOR SELECT TO vigor_app USING (true);
CREATE POLICY migrate_all ON permissions TO vigor_migrate USING (true) WITH CHECK (true);

ALTER TABLE platform_feature_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_feature_flags FORCE ROW LEVEL SECURITY;
CREATE POLICY app_read ON platform_feature_flags FOR SELECT TO vigor_app USING (true);
CREATE POLICY migrate_all ON platform_feature_flags TO vigor_migrate USING (true) WITH CHECK (true);

-- legal_entities: the app sees ONLY entities linked to the current tenant (rules 30, 33).
-- Without tenant context nothing is visible. customers joins this predicate in 0.2b.
ALTER TABLE legal_entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE legal_entities FORCE ROW LEVEL SECURITY;
CREATE POLICY app_read_linked ON legal_entities FOR SELECT TO vigor_app
  USING (EXISTS (
    SELECT 1 FROM tenant_companies tc
    WHERE tc.legal_entity_id = legal_entities.id AND tc.tenant_id = app_tenant_id()
  ));
CREATE POLICY migrate_all ON legal_entities TO vigor_migrate USING (true) WITH CHECK (true);

-- Tenant tables: one isolation policy for every role (owner included, thanks to FORCE).
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenants
  USING (id = app_tenant_id()) WITH CHECK (id = app_tenant_id());

ALTER TABLE tenant_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_settings
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

ALTER TABLE tenant_companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_companies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_companies
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON users
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON roles
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON role_permissions
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_roles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON user_roles
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

ALTER TABLE feature_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE feature_flags FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON feature_flags
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

-- audit_log: read + append within the tenant; UPDATE/DELETE have no policy AND are blocked by
-- grants and trigger.
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON audit_log FOR SELECT USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_append ON audit_log FOR INSERT WITH CHECK (tenant_id = app_tenant_id());

ALTER TABLE domain_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON domain_events
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

-- ============================================================================================
-- Grants for vigor_app (default privileges grant DML; take away what the app must not do)
-- ============================================================================================

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON
  jurisdiction_profiles, exchange_rates, pii_field_registry, permissions,
  platform_feature_flags, legal_entities
  FROM vigor_app;

-- Tenants are provisioned by the platform; the app reads its own tenant row only.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON tenants FROM vigor_app;
-- One settings row per tenant, created at provisioning; the app may edit it.
REVOKE INSERT, DELETE, TRUNCATE ON tenant_settings FROM vigor_app;
-- Companies and users are deactivated via status, never deleted.
REVOKE DELETE, TRUNCATE ON tenant_companies, users FROM vigor_app;
REVOKE TRUNCATE ON roles, role_permissions, user_roles FROM vigor_app;
REVOKE DELETE, TRUNCATE ON feature_flags FROM vigor_app;
-- Rule 6: audit_log is INSERT-only.
REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM vigor_app;
-- The app appends events; status is advanced by the worker role (task 1.5).
REVOKE UPDATE, DELETE, TRUNCATE ON domain_events FROM vigor_app;

-- ============================================================================================
-- Seed: settlement flags off at platform level (rule 31)
-- ============================================================================================

INSERT INTO platform_feature_flags (key, enabled) VALUES
  ('settlement.bilateral', false),
  ('settlement.multilateral_manual', false),
  ('settlement.engine', false),
  ('settlement.room', false),
  ('settlement.partner_desk', false),
  ('settlement.network', false),
  ('settlement.marketplace', false);

-- ============================================================================================
-- PII registry (rule 20). Explicit classes first; every remaining column is P0.
-- ============================================================================================

INSERT INTO pii_field_registry (table_name, column_name, pii_class, conditional_on, conditional_pii_class, purpose) VALUES
  ('users', 'email', 'P1', NULL, NULL, 'login identity and notifications'),
  ('users', 'display_name', 'P1', NULL, NULL, 'shown to colleagues in the tenant'),
  -- Company identity is not personal data; it becomes personal for a natural person (sole trader).
  ('legal_entities', 'legal_name', 'P0', 'customers.is_natural_person = true', 'P1', 'legal identity of the party'),
  ('legal_entities', 'normalized_name', 'P0', 'customers.is_natural_person = true', 'P1', 'matching and deduplication'),
  ('legal_entities', 'tax_id', 'P0', 'customers.is_natural_person = true', 'P2', 'legal identity of the party'),
  ('legal_entities', 'registration_number', 'P0', 'customers.is_natural_person = true', 'P2', 'legal identity of the party'),
  ('legal_entities', 'address_line1', 'P0', 'customers.is_natural_person = true', 'P2', 'registered address'),
  ('legal_entities', 'address_line2', 'P0', 'customers.is_natural_person = true', 'P2', 'registered address'),
  ('legal_entities', 'postal_code', 'P0', 'customers.is_natural_person = true', 'P2', 'registered address'),
  ('legal_entities', 'city', 'P0', 'customers.is_natural_person = true', 'P2', 'registered address'),
  ('legal_entities', 'region', 'P0', 'customers.is_natural_person = true', 'P2', 'registered address'),
  ('tenant_companies', 'display_name', 'P0', 'legal entity is a natural person', 'P1', 'tenant-facing company name'),
  -- Snapshots and payloads may carry any registered field → highest class present in 0.2a.
  ('audit_log', 'before', 'P2', NULL, NULL, 'audit snapshot before change'),
  ('audit_log', 'after', 'P2', NULL, NULL, 'audit snapshot after change'),
  ('domain_events', 'payload', 'P2', NULL, NULL, 'event payload for rules and notifications'),
  ('domain_events', 'last_error', 'P1', NULL, NULL, 'worker diagnostics; may echo payload values');

INSERT INTO pii_field_registry (table_name, column_name, pii_class, purpose)
SELECT c.table_name, c.column_name, 'P0', 'not personal data (registered by 001)'
FROM information_schema.columns c
WHERE c.table_schema = 'public'
  AND c.table_name IN (
    'schema_migrations', 'jurisdiction_profiles', 'exchange_rates', 'pii_field_registry',
    'permissions', 'platform_feature_flags', 'legal_entities', 'tenants', 'tenant_settings',
    'tenant_companies', 'users', 'roles', 'role_permissions', 'user_roles', 'feature_flags',
    'audit_log', 'domain_events'
  )
ON CONFLICT (table_name, column_name) DO NOTHING;
