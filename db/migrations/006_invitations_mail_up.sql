-- 006_invitations_mail_up.sql — Sprint 1, task 1.1b.
-- tenants.is_demo (rule 24), one-time user invitations (only a hash of the token is stored) and
-- mail_outbox (the sink: recipient and body encrypted, ADR 0003 / ADR 0004).
-- Applied by scripts/migrate.sh as vigor_migrate in one transaction. Protected file (rule 13).

-- ============================================================================================
-- tenants.is_demo — a demo tenant sends e-mail only to the sink (rule 24)
-- ============================================================================================

ALTER TABLE tenants ADD COLUMN is_demo boolean NOT NULL DEFAULT false;
-- Tenant #0 operates the platform; it is never a demo tenant.
ALTER TABLE tenants ADD CONSTRAINT tenants_platform_not_demo
  CHECK (NOT (is_demo AND is_platform_operator));

-- ============================================================================================
-- user_invitations — one-time invitation of an existing public.users row (status 'invited')
-- ============================================================================================

-- The token (32 random bytes) exists in plaintext only in the e-mail; the table keeps its
-- SHA-256. Accepting = auth identity + link to the users row + role from role_key + audit, in one
-- tenant transaction (src/server/auth/invitations.ts). A new invitation for the same user revokes
-- the pending one (re-sending = new token; the old token can never be recovered).
CREATE TABLE user_invitations (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid        NOT NULL REFERENCES tenants (id),
  user_id      uuid        NOT NULL,
  role_key     text        NOT NULL,
  token_hash   bytea       NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  invited_by   uuid        NOT NULL,
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  status       text        NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'accepted', 'revoked')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid,
  updated_by   uuid,
  CONSTRAINT user_invitations_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT user_invitations_user FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id),
  CONSTRAINT user_invitations_inviter
    FOREIGN KEY (tenant_id, invited_by) REFERENCES users (tenant_id, id),
  CONSTRAINT user_invitations_role FOREIGN KEY (tenant_id, role_key) REFERENCES roles (tenant_id, key),
  CONSTRAINT user_invitations_not_self CHECK (user_id <> invited_by),
  CONSTRAINT user_invitations_used_at CHECK ((status = 'accepted') = (used_at IS NOT NULL)),
  -- 72 h at most (ADR 0004); the service sets exactly 72 h.
  CONSTRAINT user_invitations_lifetime
    CHECK (expires_at > created_at AND expires_at <= created_at + interval '72 hours')
);
-- At most one pending invitation per user.
CREATE UNIQUE INDEX user_invitations_single_pending ON user_invitations (tenant_id, user_id)
  WHERE status = 'pending';

-- Pending content is frozen; a decided invitation is final; an expired one can no longer be
-- accepted (the DB enforces single use and expiry, not only the service).
CREATE FUNCTION user_invitations_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'user_invitations: a decided invitation is final' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.user_id, NEW.role_key, NEW.token_hash, NEW.invited_by,
      NEW.expires_at, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.user_id, OLD.role_key, OLD.token_hash, OLD.invited_by,
      OLD.expires_at, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'user_invitations: content is frozen' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'accepted' AND OLD.expires_at <= now() THEN
    RAISE EXCEPTION 'user_invitations: invitation expired' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER user_invitations_updated_at BEFORE UPDATE ON user_invitations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER user_invitations_final BEFORE UPDATE ON user_invitations
  FOR EACH ROW EXECUTE FUNCTION user_invitations_guard();

-- Token hash presented by the invitee (SET LOCAL app.invite_token_hash, hex) — the pre-tenant
-- lookup key, analogous to app_auth_user_id() in 005.
CREATE FUNCTION app_invite_token_hash() RETURNS bytea
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = pg_catalog
AS $$ SELECT decode(nullif(current_setting('app.invite_token_hash', true), ''), 'hex') $$;

ALTER TABLE user_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_invitations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON user_invitations
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
-- Before any tenant is set, the holder of the token sees exactly that one row (SELECT only) —
-- this is how the invitation's tenant is found. Never while a tenant is set (005 lesson:
-- permissive policies are OR-ed).
CREATE POLICY invite_token_lookup ON user_invitations FOR SELECT TO vigor_app
  USING (app_tenant_id() IS NULL AND token_hash = app_invite_token_hash());

-- Invitations are revoked or accepted, never deleted.
REVOKE DELETE, TRUNCATE ON user_invitations FROM vigor_app;

-- ============================================================================================
-- mail_outbox — every outgoing e-mail; transport 'sink' = captured, never delivered
-- ============================================================================================

-- Recipient and body (subject + text, incl. one-time links) are encrypted with a per-tenant key
-- derived from PII_MASTER_KEYS (HKDF, src/server/mail/crypto.ts); *_key_version = master key
-- version. Retention 7 days through the retention job (1.3, BACKLOG).
CREATE TABLE mail_outbox (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid        NOT NULL REFERENCES tenants (id),
  kind                   text        NOT NULL CHECK (kind IN ('invitation', 'password_reset')),
  transport              text        NOT NULL CHECK (transport IN ('sink', 'smtp')),
  status                 text        NOT NULL CHECK (status IN ('captured', 'pending', 'sent', 'failed')),
  recipient_enc          bytea       NOT NULL,
  recipient_key_version  integer     NOT NULL CHECK (recipient_key_version >= 1),
  body_enc               bytea       NOT NULL,
  body_key_version       integer     NOT NULL CHECK (body_key_version >= 1),
  sent_at                timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  created_by             uuid,
  updated_by             uuid,
  CONSTRAINT mail_outbox_tenant_key UNIQUE (tenant_id, id),
  -- The sink captures; only a real transport queues and sends.
  CONSTRAINT mail_outbox_sink_status CHECK ((transport = 'sink') = (status = 'captured')),
  CONSTRAINT mail_outbox_sent_at CHECK ((status = 'sent') = (sent_at IS NOT NULL))
);
CREATE INDEX mail_outbox_tenant_created ON mail_outbox (tenant_id, created_at);

-- Rule 24 in the database as well: a demo tenant's mail can only go to the sink.
CREATE FUNCTION mail_outbox_demo_sink_only() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
BEGIN
  IF NEW.transport <> 'sink' AND EXISTS (
    SELECT 1 FROM tenants t WHERE t.id = NEW.tenant_id AND t.is_demo
  ) THEN
    RAISE EXCEPTION 'mail_outbox: a demo tenant sends e-mail only to the sink (rule 24)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER mail_outbox_updated_at BEFORE UPDATE ON mail_outbox
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER mail_outbox_demo_sink BEFORE INSERT OR UPDATE ON mail_outbox
  FOR EACH ROW EXECUTE FUNCTION mail_outbox_demo_sink_only();

ALTER TABLE mail_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE mail_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mail_outbox
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

-- The app appends; delivery status is advanced by the worker (1.3), deletion by retention.
REVOKE UPDATE, DELETE, TRUNCATE ON mail_outbox FROM vigor_app;

-- ============================================================================================
-- PII registry (rule 20)
-- ============================================================================================

INSERT INTO pii_field_registry
  (table_name, column_name, pii_class, conditional_on, conditional_pii_class, encrypted, exception_reason, purpose)
VALUES
  ('user_invitations', 'token_hash', 'P3', NULL, NULL, false,
   'one-way SHA-256 of a 256-bit random token; the token itself is never stored', 'one-time invitation lookup'),
  ('mail_outbox', 'recipient_enc', 'P1', NULL, NULL, true, NULL, 'recipient e-mail address'),
  ('mail_outbox', 'body_enc', 'P3', NULL, NULL, true, NULL, 'subject and text incl. one-time links');

INSERT INTO pii_field_registry (table_name, column_name, pii_class, purpose)
SELECT c.table_name, c.column_name, 'P0', 'not personal data (registered by 006)'
FROM information_schema.columns c
WHERE c.table_schema = 'public'
  AND (c.table_name IN ('user_invitations', 'mail_outbox')
       OR (c.table_name, c.column_name) IN (('tenants', 'is_demo')))
ON CONFLICT (table_name, column_name) DO NOTHING;
