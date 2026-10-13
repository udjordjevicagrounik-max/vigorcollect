#!/usr/bin/env bash
# Golden DB tests against the isolated test database (collect_test) — never the dev DB.
#   1. the DB must be reachable (pg_isready) — otherwise a clear message, no stack trace
#   2. the test database must exist (./scripts/setup-tools.sh creates it)
#   3. pending migrations (incl. uncommitted proposals) are applied to the TEST database
#   4. vitest runs tests/golden/db
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/env.sh
source "$ROOT/scripts/lib/env.sh"

fail() { printf 'test:db: %s\n' "$*" >&2; exit 1; }

[[ -n "${TEST_MIGRATE_DATABASE_URL:-}" && -n "${TEST_DATABASE_URL:-}" ]] ||
  fail "TEST_DATABASE_URL / TEST_MIGRATE_DATABASE_URL nisu podešeni (.env)."
command -v pg_isready >/dev/null || fail "pg_isready nije instaliran — pokreni ./scripts/setup-tools.sh."

if ! pg_isready -q -t 3 -d "$TEST_MIGRATE_DATABASE_URL"; then
  fail "baza ne radi — pokreni db (runbook korak 2): docker compose up -d db"
fi
if ! psql "$TEST_MIGRATE_DATABASE_URL" -XqtAc 'SELECT 1' >/dev/null 2>&1; then
  fail "test baza $TEST_DB_NAME ne postoji ili nije dostupna — pokreni ./scripts/setup-tools.sh"
fi

MIGRATE_DATABASE_URL="$TEST_MIGRATE_DATABASE_URL" "$ROOT/scripts/migrate.sh" up >/dev/null ||
  fail "migracije na $TEST_DB_NAME nisu prošle (pokreni: MIGRATE_DATABASE_URL=… ./scripts/migrate.sh status)"

cd "$ROOT"
exec npx vitest run --config vitest.db.config.ts "$@"
