# Shared env loading for repo scripts. Source it; never execute.
# Loads .env (if the variables are not already set) and derives the test-database URLs:
# TEST_DATABASE_URL / TEST_MIGRATE_DATABASE_URL default to the dev URLs with the database
# name replaced by "<POSTGRES_DB>_test" (e.g. collect → collect_test).

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if [[ -f "$REPO_ROOT/.env" && -z "${MIGRATE_DATABASE_URL:-}" ]]; then
  # shellcheck disable=SC1091
  set -a && source "$REPO_ROOT/.env" && set +a
fi

TEST_DB_NAME="${TEST_DB_NAME:-${POSTGRES_DB:-collect}_test}"

swap_db_name() { # $1 = postgres URL → same URL pointing at $TEST_DB_NAME
  local url="$1" base query=""
  if [[ "$url" == *\?* ]]; then query="?${url#*\?}"; url="${url%%\?*}"; fi
  base="${url%/*}"
  printf '%s/%s%s' "$base" "$TEST_DB_NAME" "$query"
}

if [[ -z "${TEST_DATABASE_URL:-}" && -n "${DATABASE_URL:-}" ]]; then
  TEST_DATABASE_URL="$(swap_db_name "$DATABASE_URL")"
fi
if [[ -z "${TEST_MIGRATE_DATABASE_URL:-}" && -n "${MIGRATE_DATABASE_URL:-}" ]]; then
  TEST_MIGRATE_DATABASE_URL="$(swap_db_name "$MIGRATE_DATABASE_URL")"
fi
if [[ -z "${TEST_WORKER_DATABASE_URL:-}" && -n "${WORKER_DATABASE_URL:-}" ]]; then
  TEST_WORKER_DATABASE_URL="$(swap_db_name "$WORKER_DATABASE_URL")"
fi
export TEST_DB_NAME TEST_DATABASE_URL TEST_MIGRATE_DATABASE_URL TEST_WORKER_DATABASE_URL
