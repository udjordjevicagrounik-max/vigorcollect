#!/usr/bin/env bash
# Creates (or re-passwords) the job-runner role vigor_worker — ONCE per Postgres cluster, as the
# superuser, BEFORE migration 007 (vigor_migrate is NOCREATEROLE). Same properties as the roles
# from db/init/01-roles.sh: never SUPERUSER, never BYPASSRLS (rule 3; ADR 0002 "Otvoreno" 2).
# The password comes from WORKER_DB_PASSWORD (env / .env) and is never printed.
#
# Dev:   ./scripts/create-worker-role.sh            (POSTGRES_USER / POSTGRES_PASSWORD from .env)
# Prod:  run on the Elestio host with the vault values exported; see docs/runbook.md.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -f "$ROOT/.env" && -z "${MIGRATE_DATABASE_URL:-}" ]]; then
  # shellcheck disable=SC1091
  set -a && source "$ROOT/.env" && set +a
fi
: "${WORKER_DB_PASSWORD:?WORKER_DB_PASSWORD is not set}"
: "${POSTGRES_USER:?POSTGRES_USER (superuser) is not set}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is not set}"
: "${MIGRATE_DATABASE_URL:?MIGRATE_DATABASE_URL is not set (host/port/database are taken from it)}"

# host, port and database of the cluster, from the migrate URL (credentials are not reused).
read -r PGHOST PGPORT PGDATABASE < <(node -e '
  const u = new URL(process.env.MIGRATE_DATABASE_URL);
  console.log(u.hostname, u.port || "5432", decodeURIComponent(u.pathname.slice(1)));')
export PGHOST PGPORT PGDATABASE PGUSER="$POSTGRES_USER" PGPASSWORD="$POSTGRES_PASSWORD"

psql -X -q -v ON_ERROR_STOP=1 --no-psqlrc -v pw="$WORKER_DB_PASSWORD" <<'SQL' >/dev/null
SELECT format(
  'CREATE ROLE vigor_worker LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT PASSWORD %L',
  :'pw')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vigor_worker') \gexec
SELECT format('ALTER ROLE vigor_worker PASSWORD %L', :'pw') \gexec
ALTER ROLE vigor_worker NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
ALTER ROLE vigor_worker SET timezone = 'UTC';
SQL
echo "create-worker-role: vigor_worker ready (password from WORKER_DB_PASSWORD, not shown)."
