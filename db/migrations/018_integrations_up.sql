-- 018_integrations_up.sql — Sprint 4.1: integration framework + API for n8n. Protected (rule 13).
--
-- Additive, with ONE constraint replacement: audit_log.actor_type gains 'api_key' (task 4.1:
-- "actor_type 'api_key' u audit-u"). Same pattern as 017 (ADR 0003 "Zamena CHECK-a"): the new
-- set is a superset of the old one, no row changes, the constraint keeps its name.
--
-- Tables: integrations (no secrets in config), integration_credentials (secrets encrypted with a
-- per-tenant key derived from the master keyring, rule 9), external_records (external id ↔ our
-- entity), sync_runs, webhook_events (exactly-once per integration + external_event_id, body
-- encrypted, dead letter), outbound_deliveries (signed POSTs to n8n with retry/backoff) and
-- api_keys (hash only; scopes = permission keys of the catalog).
--
-- Pre-tenant lookups follow the invite_token_hash pattern (006): a SELECT-only policy that
-- matches exactly one row by a GUC set for that request — the API key hash, or the integration
-- id of an inbound webhook. Nothing else is visible before the tenant is set.

-- ============================================================================================
-- audit_log: API keys are actors (CHECK superset, same name)
-- ============================================================================================

ALTER TABLE audit_log DROP CONSTRAINT audit_log_actor_type_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_actor_type_check
  CHECK (actor_type IN ('user', 'system', 'job', 'ai', 'api_key'));

-- ============================================================================================
-- integrations
-- ============================================================================================

CREATE TABLE integrations (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid        NOT NULL REFERENCES tenants (id),
  type            text        NOT NULL CHECK (type IN ('mailbox', 'erp', 'risk', 'webhook')),
  provider        text        NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_]{1,30}$'),
  name            text        NOT NULL CHECK (name <> '' AND length(name) <= 120),
  status          text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  -- Non-secret settings only (outbound URL, subscribed event types). Validated in the service.
  config          jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(config) = 'object'),
  -- Which credential signs/verifies (integration_credentials.purpose); never the secret itself.
  secret_ref      text        CHECK (secret_ref ~ '^[a-z_]{1,40}$'),
  data_source_id  uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  updated_by      uuid,
  CONSTRAINT integrations_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT integrations_data_source FOREIGN KEY (tenant_id, data_source_id) REFERENCES data_sources (tenant_id, id)
);
-- One active mailbox per tenant: outgoing collection mail has exactly one way out.
CREATE UNIQUE INDEX integrations_one_mailbox ON integrations (tenant_id)
  WHERE type = 'mailbox' AND status = 'active';
CREATE TRIGGER integrations_updated_at BEFORE UPDATE ON integrations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The integration id of an inbound webhook (SET LOCAL app.inbound_integration_id) — the only
-- thing the public inbound route may look up before it knows the tenant.
CREATE FUNCTION app_inbound_integration_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = pg_catalog
AS $$ SELECT nullif(current_setting('app.inbound_integration_id', true), '')::uuid $$;

CREATE TABLE integration_credentials (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid        NOT NULL REFERENCES tenants (id),
  integration_id  uuid        NOT NULL,
  purpose         text        NOT NULL CHECK (purpose IN ('signing')),
  secret_enc          bytea       NOT NULL,
  secret_key_version  integer     NOT NULL CHECK (secret_key_version >= 1),
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  revoked_at      timestamptz,
  CONSTRAINT integration_credentials_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT integration_credentials_integration
    FOREIGN KEY (tenant_id, integration_id) REFERENCES integrations (tenant_id, id)
);
CREATE UNIQUE INDEX integration_credentials_active ON integration_credentials (tenant_id, integration_id, purpose)
  WHERE revoked_at IS NULL;

CREATE TABLE external_records (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid        NOT NULL REFERENCES tenants (id),
  integration_id  uuid        NOT NULL,
  external_id     text        NOT NULL CHECK (length(external_id) BETWEEN 1 AND 300),
  entity_type     text        NOT NULL CHECK (entity_type ~ '^[a-z][a-z0-9_]{1,62}$'),
  entity_id       uuid        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  CONSTRAINT external_records_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT external_records_integration
    FOREIGN KEY (tenant_id, integration_id) REFERENCES integrations (tenant_id, id),
  CONSTRAINT external_records_once UNIQUE (tenant_id, integration_id, entity_type, external_id)
);
CREATE INDEX external_records_entity ON external_records (tenant_id, entity_type, entity_id);

CREATE TABLE sync_runs (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid        NOT NULL REFERENCES tenants (id),
  integration_id  uuid,
  provider        text        NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_]{1,30}$'),
  kind            text        NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_.]{1,62}$'),
  status          text        NOT NULL DEFAULT 'running'
                              CHECK (status IN ('running', 'succeeded', 'partial', 'failed', 'unsupported')),
  -- Counters only ({"received": 3, "linked": 2}); never content.
  counts          jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(counts) = 'object'),
  error_code      text        CHECK (error_code ~ '^[a-z][a-z0-9_.]{1,62}$'),
  request_id      uuid,
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  created_by      uuid,
  CONSTRAINT sync_runs_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT sync_runs_integration FOREIGN KEY (tenant_id, integration_id) REFERENCES integrations (tenant_id, id),
  CONSTRAINT sync_runs_finished CHECK ((status = 'running') = (finished_at IS NULL))
);
CREATE INDEX sync_runs_recent ON sync_runs (tenant_id, started_at DESC);

-- ============================================================================================
-- webhook_events — inbound, exactly once per (integration, external_event_id)
-- ============================================================================================

-- Only requests with a valid signature and a fresh timestamp are stored (an unsigned request
-- must not be able to occupy an external_event_id); signature_ok records the check that ran.
-- The body is untrusted input (rule 22), encrypted (it may name people), processed by the worker.
CREATE TABLE webhook_events (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid        NOT NULL REFERENCES tenants (id),
  integration_id      uuid        NOT NULL,
  external_event_id   text        NOT NULL CHECK (length(external_event_id) BETWEEN 1 AND 200),
  event_type          text        NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  received_at         timestamptz NOT NULL DEFAULT now(),
  signature_ok        boolean     NOT NULL CHECK (signature_ok),
  body_enc            bytea       NOT NULL,
  body_key_version    integer     NOT NULL CHECK (body_key_version >= 1),
  status              text        NOT NULL DEFAULT 'received'
                                  CHECK (status IN ('received', 'processed', 'failed', 'dead')),
  attempts            integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  processed_at        timestamptz,
  dead_letter_reason  text        CHECK (dead_letter_reason ~ '^[a-z][a-z0-9_.]{1,62}$'),
  request_id          uuid,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid,
  CONSTRAINT webhook_events_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT webhook_events_integration FOREIGN KEY (tenant_id, integration_id) REFERENCES integrations (tenant_id, id),
  CONSTRAINT webhook_events_once UNIQUE (tenant_id, integration_id, external_event_id),
  CONSTRAINT webhook_events_processed CHECK ((status = 'processed') = (processed_at IS NOT NULL)),
  CONSTRAINT webhook_events_dead CHECK ((status = 'dead') = (dead_letter_reason IS NOT NULL))
);
CREATE INDEX webhook_events_open ON webhook_events (tenant_id, received_at) WHERE status <> 'processed';
CREATE TRIGGER webhook_events_updated_at BEFORE UPDATE ON webhook_events
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================================================
-- outbound_deliveries — signed POSTs to an integration (n8n) with retry/backoff
-- ============================================================================================

CREATE TABLE outbound_deliveries (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid        NOT NULL REFERENCES tenants (id),
  integration_id    uuid        NOT NULL,
  -- The domain event delivered (NULL for a test ping).
  event_id          uuid,
  event_type        text        NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  -- 'sink': a demo tenant never sends outside the sink (rule 24) — recorded, not sent.
  status            text        NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending', 'sent', 'failed', 'dead', 'sink')),
  attempts          integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at   timestamptz NOT NULL DEFAULT now(),
  last_status_code  integer     CHECK (last_status_code BETWEEN 100 AND 599),
  last_error        text        CHECK (last_error ~ '^[a-z][a-z0-9_.]{1,62}$'),
  sent_at           timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid,
  CONSTRAINT outbound_deliveries_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT outbound_deliveries_integration FOREIGN KEY (tenant_id, integration_id) REFERENCES integrations (tenant_id, id),
  CONSTRAINT outbound_deliveries_sent CHECK ((status = 'sent') = (sent_at IS NOT NULL))
);
-- One delivery per (integration, domain event): the fan-out is idempotent.
CREATE UNIQUE INDEX outbound_deliveries_once ON outbound_deliveries (tenant_id, integration_id, event_id)
  WHERE event_id IS NOT NULL;
CREATE INDEX outbound_deliveries_due ON outbound_deliveries (tenant_id, next_attempt_at)
  WHERE status IN ('pending', 'failed');
CREATE TRIGGER outbound_deliveries_updated_at BEFORE UPDATE ON outbound_deliveries
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================================================
-- api_keys — per tenant, hash only, scopes = permission keys
-- ============================================================================================

CREATE TABLE api_keys (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid        NOT NULL REFERENCES tenants (id),
  name                   text        NOT NULL CHECK (name <> '' AND length(name) <= 120),
  -- First characters of the token, shown in lists to tell keys apart (not enough to use it).
  token_prefix           text        NOT NULL CHECK (token_prefix ~ '^[A-Za-z0-9_-]{8,16}$'),
  -- SHA-256 of a 256-bit random token: the token itself is shown once and never stored.
  key_hash               bytea       NOT NULL UNIQUE CHECK (octet_length(key_hash) = 32),
  scopes                 text[]      NOT NULL CHECK (cardinality(scopes) BETWEEN 1 AND 100),
  rate_limit_per_minute  integer     NOT NULL DEFAULT 60 CHECK (rate_limit_per_minute BETWEEN 1 AND 6000),
  last_used_at           timestamptz,
  revoked_at             timestamptz,
  revoked_by             uuid,
  created_at             timestamptz NOT NULL DEFAULT now(),
  created_by             uuid        NOT NULL,
  CONSTRAINT api_keys_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT api_keys_created_by FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id),
  CONSTRAINT api_keys_revoked CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);

-- The presented token's hash (SET LOCAL app.api_key_hash, hex).
CREATE FUNCTION app_api_key_hash() RETURNS bytea
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = pg_catalog
AS $$ SELECT decode(nullif(current_setting('app.api_key_hash', true), ''), 'hex') $$;

-- ============================================================================================
-- RLS (explicit per table) + grants
-- ============================================================================================

ALTER TABLE integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE integrations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON integrations
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY inbound_lookup ON integrations FOR SELECT TO vigor_app
  USING (app_tenant_id() IS NULL AND id = app_inbound_integration_id());

ALTER TABLE integration_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_credentials FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON integration_credentials
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

ALTER TABLE external_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_records FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON external_records
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

ALTER TABLE sync_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sync_runs
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

ALTER TABLE webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON webhook_events
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

ALTER TABLE outbound_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbound_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON outbound_deliveries
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON api_keys
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY api_key_lookup ON api_keys FOR SELECT TO vigor_app
  USING (app_tenant_id() IS NULL AND key_hash = app_api_key_hash());

-- History: nothing here is deleted by the app; integrations are disabled, credentials and keys
-- revoked, events and deliveries keep their status.
REVOKE DELETE, TRUNCATE ON integrations, integration_credentials, external_records, sync_runs,
  webhook_events, outbound_deliveries, api_keys FROM vigor_app;

-- ============================================================================================
-- PII registry (rule 20)
-- ============================================================================================

INSERT INTO pii_field_registry
  (table_name, column_name, pii_class, conditional_on, conditional_pii_class, encrypted, exception_reason, purpose)
VALUES
  ('webhook_events', 'body_enc', 'P3', NULL, NULL, true, NULL,
   'inbound payload from an integration (may contain e-mail content); untrusted input'),
  ('integration_credentials', 'secret_enc', 'P0', NULL, NULL, true, NULL,
   'signing secret of an integration (not personal data; encrypted, rule 9)'),
  ('api_keys', 'key_hash', 'P0', NULL, NULL, false,
   'one-way SHA-256 of a 256-bit random token; the token is never stored', 'API key lookup');

INSERT INTO pii_field_registry (table_name, column_name, pii_class, purpose)
SELECT c.table_name, c.column_name, 'P0', 'not personal data (registered by 018)'
FROM information_schema.columns c
WHERE c.table_schema = 'public'
  AND c.table_name IN ('integrations', 'integration_credentials', 'external_records', 'sync_runs',
                       'webhook_events', 'outbound_deliveries', 'api_keys')
ON CONFLICT (table_name, column_name) DO NOTHING;
