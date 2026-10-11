#!/usr/bin/env bash
# Runs ONCE on an empty Postgres volume (docker-entrypoint-initdb.d), as the superuser.
# Creates the two roles from CLAUDE.md rule 3. Protected file (rule 13).
# Staging/prod (Elestio): run the same statements manually — see docs/runbook.md.
set -euo pipefail

: "${APP_DB_PASSWORD:?APP_DB_PASSWORD is required}"
: "${MIGRATE_DB_PASSWORD:?MIGRATE_DB_PASSWORD is required}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v db="$POSTGRES_DB" -v app_pw="$APP_DB_PASSWORD" -v migrate_pw="$MIGRATE_DB_PASSWORD" <<'SQL'
-- Migration role: owns the schema objects; creates trusted extensions (pgcrypto, uuid-ossp).
CREATE ROLE vigor_migrate LOGIN PASSWORD :'migrate_pw'
  NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;

-- Application role: subject to RLS. Never SUPERUSER, never BYPASSRLS.
CREATE ROLE vigor_app LOGIN PASSWORD :'app_pw'
  NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;

-- vigor_migrate owns the database, so it owns schema public (pg_database_owner, PG15+).
ALTER DATABASE :"db" OWNER TO vigor_migrate;
REVOKE ALL ON DATABASE :"db" FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE :"db" TO vigor_app;
GRANT USAGE ON SCHEMA public TO vigor_app;

-- Tables/sequences created by vigor_migrate in public are usable by vigor_app by default.
-- RLS still filters every row. Per-table GRANT/REVOKE in migrations stays allowed (e.g. REVOKE
-- UPDATE, DELETE on audit_log), but is no longer required.
ALTER DEFAULT PRIVILEGES FOR ROLE vigor_migrate IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO vigor_app;
ALTER DEFAULT PRIVILEGES FOR ROLE vigor_migrate IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO vigor_app;
ALTER ROLE vigor_app SET timezone = 'UTC';
ALTER ROLE vigor_migrate SET timezone = 'UTC';
SQL
