-- 026_mailbox_onboarding_up.sql — Sprint 5.3: mailbox onboarding (IMAP/SMTP form, Microsoft 365).
-- Protected (rule 13). Additive only.
--
-- mailbox_connections: ONE per tenant — how Collect reads and sends the tenant's mail through n8n.
--   Every secret (username, password, sender, Microsoft refresh token) is sealed with the tenant's
--   integration key (src/server/integrations/crypto.ts, AAD = table|column|row); hosts, ports,
--   folder and n8n object ids are P0. "Check connection" → status test_requested → the worker
--   probes IMAP login + SMTP EHLO outside any transaction (review S-09), then creates the tenant's
--   n8n credentials and workflows and activates them (n8n_refs = ids only).
-- oauth_states: Microsoft 365 authorization code + PKCE. One row per started consent: hash of the
--   state, hash of the SESSION that started it (the callback must come back in the same session),
--   the sealed code_verifier; single use, 10 minutes.

CREATE TABLE mailbox_connections (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid        NOT NULL REFERENCES tenants (id),
  provider              text        NOT NULL CHECK (provider IN ('imap_smtp', 'microsoft365')),
  status                text        NOT NULL DEFAULT 'saved'
                                    CHECK (status IN ('saved', 'test_requested', 'testing', 'connected', 'failed')),
  imap_host             text        CHECK (imap_host ~ '^[A-Za-z0-9.-]{1,253}$'),
  imap_port             integer     CHECK (imap_port IN (143, 993)),
  imap_tls              boolean,
  smtp_host             text        CHECK (smtp_host ~ '^[A-Za-z0-9.-]{1,253}$'),
  smtp_port             integer     CHECK (smtp_port IN (25, 465, 587, 2525)),
  smtp_security         text        CHECK (smtp_security IN ('tls', 'starttls', 'none')),
  folder                text        NOT NULL DEFAULT 'INBOX' CHECK (length(folder) BETWEEN 1 AND 200),
  -- Sealed (integration key of the tenant): never in clear in the database or a log.
  username_enc                  bytea,
  username_key_version          integer     CHECK (username_key_version >= 1),
  password_enc                  bytea,
  password_key_version          integer     CHECK (password_key_version >= 1),
  from_address_enc              bytea,
  from_address_key_version      integer     CHECK (from_address_key_version >= 1),
  ms_refresh_token_enc          bytea,
  ms_refresh_token_key_version  integer     CHECK (ms_refresh_token_key_version >= 1),
  ms_access_expires_at  timestamptz,
  integration_id        uuid,
  -- n8n credential / workflow ids (P0), filled when connected.
  n8n_refs              jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(n8n_refs) = 'object'),
  last_test_at          timestamptz,
  last_error            text        CHECK (last_error ~ '^[a-z][a-z0-9_.]{1,62}$'),
  claimed_at            timestamptz,
  requested_by          uuid        NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mailbox_connections_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT mailbox_connections_one UNIQUE (tenant_id),
  CONSTRAINT mailbox_connections_integration FOREIGN KEY (tenant_id, integration_id) REFERENCES integrations (tenant_id, id),
  CONSTRAINT mailbox_connections_requested_by FOREIGN KEY (tenant_id, requested_by) REFERENCES users (tenant_id, id),
  CONSTRAINT mailbox_connections_imap CHECK (
    provider <> 'imap_smtp' OR (imap_host IS NOT NULL AND imap_port IS NOT NULL AND imap_tls IS NOT NULL
      AND smtp_host IS NOT NULL AND smtp_port IS NOT NULL AND smtp_security IS NOT NULL
      AND username_enc IS NOT NULL AND password_enc IS NOT NULL)),
  CONSTRAINT mailbox_connections_ms CHECK (
    provider <> 'microsoft365' OR ms_refresh_token_enc IS NOT NULL),
  CONSTRAINT mailbox_connections_versions CHECK (
    (username_enc IS NULL) = (username_key_version IS NULL)
    AND (password_enc IS NULL) = (password_key_version IS NULL)
    AND (from_address_enc IS NULL) = (from_address_key_version IS NULL)
    AND (ms_refresh_token_enc IS NULL) = (ms_refresh_token_key_version IS NULL))
);
CREATE TRIGGER mailbox_connections_updated_at BEFORE UPDATE ON mailbox_connections
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE oauth_states (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid        NOT NULL REFERENCES tenants (id),
  user_id       uuid        NOT NULL,
  provider      text        NOT NULL CHECK (provider IN ('microsoft365')),
  state_hash    bytea       NOT NULL UNIQUE CHECK (octet_length(state_hash) = 32),
  session_hash  bytea       NOT NULL CHECK (octet_length(session_hash) = 32),
  verifier_enc          bytea       NOT NULL,
  verifier_key_version  integer     NOT NULL CHECK (verifier_key_version >= 1),
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL DEFAULT now() + interval '10 minutes',
  used_at       timestamptz,
  CONSTRAINT oauth_states_user FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id)
);
CREATE INDEX oauth_states_expiry ON oauth_states (tenant_id, expires_at);

ALTER TABLE mailbox_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE mailbox_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mailbox_connections
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_states FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON oauth_states
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
REVOKE TRUNCATE ON mailbox_connections, oauth_states FROM vigor_app;

INSERT INTO pii_field_registry (table_name, column_name, pii_class, encrypted, purpose)
VALUES ('mailbox_connections', 'username_enc', 'P1', true, 'mailbox login (sealed, integration key)'),
       ('mailbox_connections', 'password_enc', 'P1', true, 'mailbox password (sealed, integration key)'),
       ('mailbox_connections', 'from_address_enc', 'P1', true, 'sender address (sealed, integration key)'),
       ('mailbox_connections', 'ms_refresh_token_enc', 'P1', true, 'Microsoft 365 refresh token (sealed)'),
       ('oauth_states', 'verifier_enc', 'P1', true, 'PKCE code_verifier (sealed, 10 minutes)');
INSERT INTO pii_field_registry (table_name, column_name, pii_class, purpose)
SELECT c.table_name, c.column_name, 'P0', 'not personal data (registered by 026)'
FROM information_schema.columns c
WHERE c.table_schema = 'public' AND c.table_name IN ('mailbox_connections', 'oauth_states')
  AND c.column_name NOT IN ('username_enc', 'password_enc', 'from_address_enc', 'ms_refresh_token_enc',
                            'verifier_enc');
