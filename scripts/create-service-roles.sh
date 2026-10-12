#!/usr/bin/env bash
# Creates (or re-passwords) the service roles — ONCE per Postgres cluster, as the superuser,
# BEFORE migrations 007 / 011 (vigor_migrate is NOCREATEROLE). Passwords come from env / .env
# and are never printed. A role whose password variable is empty is skipped.
#
#   vigor_worker   WORKER_DB_PASSWORD   jobs (ADR 0005): NOSUPERUSER NOBYPASSRLS
#   vigor_backup   BACKUP_DB_PASSWORD   pg_dump: pg_read_all_data + BYPASSRLS (FORCE RLS), reads
#                                       only — no table write (migration 011 lets it append its
#                                       own ops_runs row, kind 'backup')
#   vigor_restore  RESTORE_DB_PASSWORD  restore test: CREATEDB + BYPASSRLS for its OWN scratch
#                                       database; no access to the data of the main database
#
# Dev:   ./scripts/create-service-roles.sh   (POSTGRES_USER / POSTGRES_PASSWORD from .env)
# Prod:  on the Elestio host with the vault values exported; docs/runbook.md "Servisne role".
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -f "$ROOT/.env" && -z "${MIGRATE_DATABASE_URL:-}" ]]; then
  # shellcheck disable=SC1091
  set -a && source "$ROOT/.env" && set +a
fi
: "${POSTGRES_USER:?POSTGRES_USER (superuser) is not set}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is not set}"
: "${MIGRATE_DATABASE_URL:?MIGRATE_DATABASE_URL is not set (host/port/database are taken from it)}"

read -r PGHOST PGPORT PGDATABASE < <(node -e '
  const u = new URL(process.env.MIGRATE_DATABASE_URL);
  console.log(u.hostname, u.port || "5432", decodeURIComponent(u.pathname.slice(1)));')
export PGHOST PGPORT PGDATABASE PGUSER="$POSTGRES_USER" PGPASSWORD="$POSTGRES_PASSWORD"

# $1 role, $2 password, $3 attributes
ensure_role() {
  psql -X -q -v ON_ERROR_STOP=1 --no-psqlrc -v role="$1" -v pw="$2" -v attrs="$3" <<'SQL' >/dev/null
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'role', :'pw')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'role') \gexec
SELECT format('ALTER ROLE %I LOGIN PASSWORD %L %s', :'role', :'pw', :'attrs') \gexec
SELECT format('ALTER ROLE %I SET timezone = %L', :'role', 'UTC') \gexec
SQL
  echo "create-service-roles: $1 ready (password not shown)."
}

if [[ -n "${WORKER_DB_PASSWORD:-}" ]]; then
  ensure_role vigor_worker "$WORKER_DB_PASSWORD" \
    'NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT'
fi
if [[ -n "${BACKUP_DB_PASSWORD:-}" ]]; then
  # INHERIT: the privileges of pg_read_all_data must apply without SET ROLE.
  ensure_role vigor_backup "$BACKUP_DB_PASSWORD" \
    'NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT'
  psql -X -q -v ON_ERROR_STOP=1 --no-psqlrc -c 'GRANT pg_read_all_data TO vigor_backup' >/dev/null
fi
if [[ -n "${RESTORE_DB_PASSWORD:-}" ]]; then
  ensure_role vigor_restore "$RESTORE_DB_PASSWORD" \
    'NOSUPERUSER BYPASSRLS CREATEDB NOCREATEROLE NOREPLICATION NOINHERIT'
fi
