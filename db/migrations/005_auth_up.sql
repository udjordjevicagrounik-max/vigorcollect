-- 005_auth_up.sql — Better Auth identity in schema `auth` (task 1.1a, ADR 0004).
-- Closes ADR 0002 "Otvoreno" 1: login happens before any tenant is known, so the person's
-- identity is global (no tenant_id, no tenant RLS); public.users.auth_user_id is the bridge to
-- tenant memberships. Table and column names are Better Auth's own (quoted camelCase) — the
-- library writes them; DDL mirrors `getMigrations()` of src/server/auth/better-auth.ts.

CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA auth TO vigor_app;

CREATE TABLE auth."user" (
  "id"                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "name"              text        NOT NULL,
  "email"             text        NOT NULL UNIQUE CHECK ("email" = lower("email")),
  "emailVerified"     boolean     NOT NULL,
  "image"             text,
  "createdAt"         timestamptz NOT NULL DEFAULT now(),
  "updatedAt"         timestamptz NOT NULL DEFAULT now(),
  -- two-factor plugin
  "twoFactorEnabled"  boolean,
  -- password lockout (hooks in better-auth.ts): 5 failures → 15 min, never permanent
  "failedSignInCount" integer     CHECK ("failedSignInCount" >= 0),
  "signInLockedUntil" timestamptz
);

CREATE TABLE auth."session" (
  "id"             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "expiresAt"      timestamptz NOT NULL,
  "token"          text        NOT NULL UNIQUE,
  "createdAt"      timestamptz NOT NULL DEFAULT now(),
  "updatedAt"      timestamptz NOT NULL,
  "ipAddress"      text,
  "userAgent"      text,
  "userId"         uuid        NOT NULL REFERENCES auth."user" ("id") ON DELETE CASCADE,
  -- The ONLY tenant source for withTenant() (task 1.2); validated against memberships on write.
  "activeTenantId" uuid
);
CREATE INDEX "session_userId_idx" ON auth."session" ("userId");

CREATE TABLE auth."account" (
  "id"                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "accountId"             text        NOT NULL,
  "providerId"            text        NOT NULL,
  "userId"                uuid        NOT NULL REFERENCES auth."user" ("id") ON DELETE CASCADE,
  "accessToken"           text,
  "refreshToken"          text,
  "idToken"               text,
  "accessTokenExpiresAt"  timestamptz,
  "refreshTokenExpiresAt" timestamptz,
  "scope"                 text,
  "password"              text,
  "createdAt"             timestamptz NOT NULL DEFAULT now(),
  "updatedAt"             timestamptz NOT NULL
);
CREATE INDEX "account_userId_idx" ON auth."account" ("userId");

CREATE TABLE auth."verification" (
  "id"         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "identifier" text        NOT NULL,
  "value"      text        NOT NULL,
  "expiresAt"  timestamptz NOT NULL,
  "createdAt"  timestamptz NOT NULL DEFAULT now(),
  "updatedAt"  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "verification_identifier_idx" ON auth."verification" ("identifier");

CREATE TABLE auth."twoFactor" (
  "id"                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "secret"                  text        NOT NULL,
  "backupCodes"             text        NOT NULL,
  "userId"                  uuid        NOT NULL REFERENCES auth."user" ("id") ON DELETE CASCADE,
  "verified"                boolean,
  "failedVerificationCount" integer,
  "lockedUntil"             timestamptz
);
CREATE INDEX "twoFactor_secret_idx" ON auth."twoFactor" ("secret");
CREATE INDEX "twoFactor_userId_idx" ON auth."twoFactor" ("userId");

CREATE TABLE auth."rateLimit" (
  "id"          uuid   PRIMARY KEY DEFAULT gen_random_uuid(),
  "key"         text   NOT NULL UNIQUE,
  "count"       integer NOT NULL,
  "lastRequest" bigint NOT NULL
);

-- ============================================================================================
-- RLS: ENABLE + FORCE like every table, but NO tenant predicate (identity precedes tenant).
-- vigor_app is Better Auth's runtime role; vigor_migrate maintains (seed, runbook).
-- ============================================================================================

ALTER TABLE auth."user" ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth."user" FORCE ROW LEVEL SECURITY;
CREATE POLICY app_all ON auth."user" TO vigor_app USING (true) WITH CHECK (true);
CREATE POLICY migrate_all ON auth."user" TO vigor_migrate USING (true) WITH CHECK (true);

ALTER TABLE auth."session" ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth."session" FORCE ROW LEVEL SECURITY;
CREATE POLICY app_all ON auth."session" TO vigor_app USING (true) WITH CHECK (true);
CREATE POLICY migrate_all ON auth."session" TO vigor_migrate USING (true) WITH CHECK (true);

ALTER TABLE auth."account" ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth."account" FORCE ROW LEVEL SECURITY;
CREATE POLICY app_all ON auth."account" TO vigor_app USING (true) WITH CHECK (true);
CREATE POLICY migrate_all ON auth."account" TO vigor_migrate USING (true) WITH CHECK (true);

ALTER TABLE auth."verification" ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth."verification" FORCE ROW LEVEL SECURITY;
CREATE POLICY app_all ON auth."verification" TO vigor_app USING (true) WITH CHECK (true);
CREATE POLICY migrate_all ON auth."verification" TO vigor_migrate USING (true) WITH CHECK (true);

ALTER TABLE auth."twoFactor" ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth."twoFactor" FORCE ROW LEVEL SECURITY;
CREATE POLICY app_all ON auth."twoFactor" TO vigor_app USING (true) WITH CHECK (true);
CREATE POLICY migrate_all ON auth."twoFactor" TO vigor_migrate USING (true) WITH CHECK (true);

ALTER TABLE auth."rateLimit" ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth."rateLimit" FORCE ROW LEVEL SECURITY;
CREATE POLICY app_all ON auth."rateLimit" TO vigor_app USING (true) WITH CHECK (true);
CREATE POLICY migrate_all ON auth."rateLimit" TO vigor_migrate USING (true) WITH CHECK (true);

-- DML only on the tables Better Auth writes — never TRUNCATE, never DDL.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  auth."user", auth."session", auth."account", auth."verification", auth."twoFactor", auth."rateLimit"
  TO vigor_app;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON
  auth."user", auth."session", auth."account", auth."verification", auth."twoFactor", auth."rateLimit"
  FROM vigor_app;

-- ============================================================================================
-- Bridge: person → tenant memberships
-- ============================================================================================

-- NOT VALID: rows written before this migration are not re-checked (after a dev `down 005`
-- their ids dangle and RLS hides them from vigor_migrate); every new write is checked. The seed
-- relinks; VALIDATE CONSTRAINT follows once no environment has pre-005 links (BACKLOG).
ALTER TABLE users
  ADD CONSTRAINT users_auth_user FOREIGN KEY (auth_user_id) REFERENCES auth."user" ("id") NOT VALID;

-- Verified person id, set by the app (SET LOCAL app.auth_user_id) only from a Better Auth
-- session or sign-in — the pre-tenant counterpart of app_tenant_id().
CREATE FUNCTION app_auth_user_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = pg_catalog
AS $$ SELECT nullif(current_setting('app.auth_user_id', true), '')::uuid $$;

-- Read-only, own rows only: the person sees their membership rows and the names of those
-- tenants — nothing else, and nothing without app.auth_user_id (rules 2, 32).
-- Pre-tenant ONLY (app_tenant_id() IS NULL): policies are permissive (OR-ed with
-- tenant_isolation), so without that condition a session in tenant A would also see the
-- person's own rows in tenant B.
CREATE POLICY auth_membership_read ON users FOR SELECT TO vigor_app
  USING (app_tenant_id() IS NULL AND auth_user_id = app_auth_user_id());
CREATE POLICY auth_membership_read ON tenants FOR SELECT TO vigor_app
  USING (app_tenant_id() IS NULL AND EXISTS (
    SELECT 1 FROM users u WHERE u.tenant_id = tenants.id AND u.auth_user_id = app_auth_user_id()
  ));

-- ============================================================================================
-- PII registry (rule 20). Schema-qualified names for schema auth.
-- ============================================================================================

INSERT INTO pii_field_registry (table_name, column_name, pii_class, purpose, exception_reason) VALUES
  ('auth.user', 'name', 'P1', 'display name of the person at sign-in', 'auth identity'),
  ('auth.user', 'email', 'P1', 'sign-in identifier', 'auth identity'),
  ('auth.user', 'image', 'P1', 'avatar URL (unused)', 'auth identity'),
  ('auth.session', 'ipAddress', 'P1', 'session security (anomaly checks)', 'security telemetry; deleted with the session'),
  ('auth.session', 'userAgent', 'P1', 'session security (device list)', 'security telemetry; deleted with the session'),
  ('auth.session', 'token', 'P3', 'session bearer secret', 'credential, not personal data; random, rotated on sign-in'),
  ('auth.account', 'password', 'P3', 'password hash (scrypt)', 'one-way hash by Better Auth'),
  ('auth.account', 'accessToken', 'P3', 'OAuth token (unused: email+password only)', 'unused column of the library'),
  ('auth.account', 'refreshToken', 'P3', 'OAuth token (unused: email+password only)', 'unused column of the library'),
  ('auth.account', 'idToken', 'P3', 'OAuth token (unused: email+password only)', 'unused column of the library'),
  ('auth.verification', 'identifier', 'P1', 'reset / verification target (may be an email)', 'short-lived, deleted on use or expiry'),
  ('auth.verification', 'value', 'P3', 'one-time token payload', 'short-lived, deleted on use or expiry'),
  ('auth.twoFactor', 'secret', 'P3', 'TOTP secret', 'encrypted by Better Auth with BETTER_AUTH_SECRET'),
  ('auth.twoFactor', 'backupCodes', 'P3', 'TOTP backup codes', 'encrypted by Better Auth with BETTER_AUTH_SECRET'),
  ('auth.rateLimit', 'key', 'P1', 'rate-limit bucket (IP + path)', 'security telemetry; overwritten every window');

INSERT INTO pii_field_registry (table_name, column_name, pii_class, purpose)
SELECT c.table_schema || '.' || c.table_name, c.column_name, 'P0', 'not personal data (registered by 005)'
FROM information_schema.columns c
WHERE c.table_schema = 'auth'
ON CONFLICT (table_name, column_name) DO NOTHING;
