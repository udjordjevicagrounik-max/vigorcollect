#!/usr/bin/env bash
# Creates the isolated golden-test database (<POSTGRES_DB>_test, e.g. collect_test) inside the
# running compose `db` service. Idempotent. Golden DB fixtures live ONLY there — never in the
# dev database. Mirrors the privileges db/init/01-roles.sh sets on the dev database
# (default privileges are per database, so they must be repeated here).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/env.sh
source "$ROOT/scripts/lib/env.sh"
log() { printf '[setup-test-db] %s\n' "$*"; }

: "${POSTGRES_USER:?POSTGRES_USER missing (.env)}"
cd "$ROOT"

if ! docker compose ps --status running --services 2>/dev/null | grep -qx db; then
  log "db service is not running — skipped (runbook step 2: docker compose up -d db)."
  exit 0
fi

su_psql() { docker compose exec -T db psql -X -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" "$@"; }

exists="$(su_psql -d postgres -tA -v name="$TEST_DB_NAME" <<'SQL'
SELECT 1 FROM pg_database WHERE datname = :'name';
SQL
)"
if [[ "$exists" != "1" ]]; then
  log "creating database $TEST_DB_NAME"
  su_psql -d postgres -v name="$TEST_DB_NAME" <<'SQL'
CREATE DATABASE :"name" OWNER vigor_migrate;
SQL
fi

su_psql -d "$TEST_DB_NAME" -v name="$TEST_DB_NAME" <<'SQL'
REVOKE ALL ON DATABASE :"name" FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE :"name" TO vigor_app;
GRANT USAGE ON SCHEMA public TO vigor_app;
ALTER DEFAULT PRIVILEGES FOR ROLE vigor_migrate IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO vigor_app;
ALTER DEFAULT PRIVILEGES FOR ROLE vigor_migrate IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO vigor_app;
SQL
log "database $TEST_DB_NAME ready (owner vigor_migrate, vigor_app default DML privileges)."
