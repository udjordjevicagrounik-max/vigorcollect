# Superuser connection for ops scripts (backup, restore test, worker role). Source it; never
# execute. pg_dump must read past FORCE RLS, which only a superuser does. Credentials:
# BACKUP_DATABASE_URL if set, else POSTGRES_USER / POSTGRES_PASSWORD with host/port from
# MIGRATE_DATABASE_URL. Nothing is printed.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ -f "$ROOT/.env" && -z "${MIGRATE_DATABASE_URL:-}${BACKUP_DATABASE_URL:-}" ]]; then
  # shellcheck disable=SC1091
  set -a && source "$ROOT/.env" && set +a
fi

if [[ -n "${BACKUP_DATABASE_URL:-}" ]]; then
  read -r PGHOST PGPORT PGUSER PGDATABASE < <(BACKUP_DATABASE_URL="$BACKUP_DATABASE_URL" node -e '
    const u = new URL(process.env.BACKUP_DATABASE_URL);
    console.log(u.hostname, u.port || "5432", decodeURIComponent(u.username), decodeURIComponent(u.pathname.slice(1)) || "postgres");')
  PGPASSWORD="$(BACKUP_DATABASE_URL="$BACKUP_DATABASE_URL" node -e 'process.stdout.write(decodeURIComponent(new URL(process.env.BACKUP_DATABASE_URL).password))')"
else
  : "${POSTGRES_USER:?POSTGRES_USER (superuser) or BACKUP_DATABASE_URL is required}"
  : "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"
  : "${MIGRATE_DATABASE_URL:?MIGRATE_DATABASE_URL is required (host/port)}"
  read -r PGHOST PGPORT PGDATABASE < <(node -e '
    const u = new URL(process.env.MIGRATE_DATABASE_URL);
    console.log(u.hostname, u.port || "5432", decodeURIComponent(u.pathname.slice(1)));')
  PGUSER="$POSTGRES_USER"
  PGPASSWORD="$POSTGRES_PASSWORD"
fi
export PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE
MAIN_DB="${POSTGRES_DB:-$PGDATABASE}"
BACKUP_DIR="${BACKUP_DIR:-/srv/backups}"

# Records an ops run in the main database (ops_runs, migration 010). $1 kind, $2 status,
# $3 started (ISO), $4 details JSON (P0 values only).
record_ops_run() {
  psql -X -q -v ON_ERROR_STOP=1 --no-psqlrc -d "$MAIN_DB" \
    -v kind="$1" -v status="$2" -v started="$3" -v details="$4" >/dev/null <<'SQL' || true
INSERT INTO ops_runs (kind, status, started_at, finished_at, details)
VALUES (:'kind', :'status', :'started'::timestamptz, now(), :'details'::jsonb);
SQL
}
