-- 000_init_up.sql — bootstrap only: extensions + migration ledger. No business tables.
-- Applied by scripts/migrate.sh as vigor_migrate. Protected file (CLAUDE.md rule 13).

CREATE EXTENSION IF NOT EXISTS pgcrypto;     -- gen_random_uuid(), pgp_sym_encrypt (rule 9)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Platform-level ledger (not tenant data: no tenant_id, no RLS needed).
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     text        PRIMARY KEY CHECK (version ~ '^[0-9]{3}$'),
  name        text        NOT NULL,
  checksum    text        NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now(),
  applied_by  text        NOT NULL DEFAULT current_user
);

-- The application role may read which migrations are applied (health/readiness), never write.
-- Explicit REVOKE overrides the default privileges vigor_app gets on new tables (db/init).
REVOKE ALL ON schema_migrations FROM PUBLIC, vigor_app;
GRANT SELECT ON schema_migrations TO vigor_app;
