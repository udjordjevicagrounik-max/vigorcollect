# Service-role connection for ops scripts. Source it after setting OPS_URL_VAR to the name of
# the URL variable: BACKUP_DATABASE_URL (vigor_backup — reads everything, writes nothing but its
# ops_runs row) or RESTORE_DATABASE_URL (vigor_restore — its own scratch database). Never the
# superuser. Nothing is printed.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ -f "$ROOT/.env" && -z "${!OPS_URL_VAR:-}" ]]; then
  # shellcheck disable=SC1091
  set -a && source "$ROOT/.env" && set +a
fi
OPS_URL="${!OPS_URL_VAR:-}"
[[ -n "$OPS_URL" ]] || { echo "$OPS_URL_VAR is not set (docs/runbook.md \"Servisne role\")" >&2; exit 2; }

read -r PGHOST PGPORT PGUSER PGDATABASE < <(OPS_URL="$OPS_URL" node -e '
  const u = new URL(process.env.OPS_URL);
  console.log(u.hostname, u.port || "5432", decodeURIComponent(u.username),
              decodeURIComponent(u.pathname.slice(1)) || "postgres");')
PGPASSWORD="$(OPS_URL="$OPS_URL" node -e 'process.stdout.write(decodeURIComponent(new URL(process.env.OPS_URL).password))')"
export PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE
MAIN_DB="${POSTGRES_DB:-$PGDATABASE}"
BACKUP_DIR="${BACKUP_DIR:-/srv/backups}"

# Records an ops run in the main database (ops_runs: each role may insert only its own kind).
# $1 kind, $2 status, $3 started (ISO), $4 details JSON (P0 values only).
record_ops_run() {
  psql -X -q -v ON_ERROR_STOP=1 --no-psqlrc -d "$MAIN_DB" \
    -v kind="$1" -v status="$2" -v started="$3" -v details="$4" >/dev/null <<'SQL' || true
INSERT INTO ops_runs (kind, status, started_at, finished_at, details)
VALUES (:'kind', :'status', :'started'::timestamptz, now(), :'details'::jsonb);
SQL
}
