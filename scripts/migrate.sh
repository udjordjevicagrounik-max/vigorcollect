#!/usr/bin/env bash
# Applies db/migrations/NNN_<name>_up.sql in order through psql as vigor_migrate (rule 4).
# Each migration + its ledger row run in ONE transaction. Applied files are immutable:
# a checksum mismatch stops the run. drizzle-kit push is forbidden.
#
# Usage: scripts/migrate.sh [up|status|down NNN]
#   up      (default) apply all pending migrations
#   status  list applied / pending
#   down N  run NNN_<name>_down.sql for the LAST applied version only (dev databases)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="$ROOT/db/migrations"

if [[ -f "$ROOT/.env" && -z "${MIGRATE_DATABASE_URL:-}" ]]; then
  # shellcheck disable=SC1091
  set -a && source "$ROOT/.env" && set +a
fi
: "${MIGRATE_DATABASE_URL:?MIGRATE_DATABASE_URL is not set (vigor_migrate connection string)}"
command -v psql >/dev/null || { echo "psql not found (install postgresql-client-16)" >&2; exit 1; }

PSQL=(psql "$MIGRATE_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 --no-psqlrc)

checksum() { sha256sum "$1" | cut -d' ' -f1; }

ledger_exists() {
  [[ "$("${PSQL[@]}" -tAc "SELECT to_regclass('public.schema_migrations') IS NOT NULL")" == "t" ]]
}

applied_checksum() { # $1 = version
  ledger_exists || return 0
  "${PSQL[@]}" -tA -v version="$1" <<'SQL'
SELECT checksum FROM schema_migrations WHERE version = :'version';
SQL
}

up_files() { find "$DIR" -maxdepth 1 -name '[0-9][0-9][0-9]_*_up.sql' -printf '%f\n' | sort; }

cmd_up() {
  local applied=0 file version name sum existing
  while IFS= read -r file; do
    version="${file:0:3}"
    name="${file:4}"; name="${name%_up.sql}"
    sum="$(checksum "$DIR/$file")"
    existing="$(applied_checksum "$version")"
    if [[ -n "$existing" ]]; then
      if [[ "$existing" != "$sum" ]]; then
        echo "ERROR: $file changed after it was applied (checksum mismatch). Write a new migration." >&2
        exit 1
      fi
      continue
    fi
    [[ -f "$DIR/${version}_${name}_down.sql" ]] || { echo "ERROR: missing ${version}_${name}_down.sql (rule 15)" >&2; exit 1; }
    echo "→ applying $file"
    { cat "$DIR/$file"; printf '\n'; cat <<'SQL'
INSERT INTO schema_migrations (version, name, checksum) VALUES (:'version', :'name', :'checksum');
SQL
    } | "${PSQL[@]}" --single-transaction -v version="$version" -v name="$name" -v checksum="$sum"
    applied=$((applied + 1))
  done < <(up_files)
  echo "migrate: $applied migration(s) applied."
}

cmd_status() {
  local file version
  while IFS= read -r file; do
    version="${file:0:3}"
    if [[ -n "$(applied_checksum "$version")" ]]; then echo "applied  $file"; else echo "pending  $file"; fi
  done < <(up_files)
}

cmd_down() {
  local version="${1:?usage: migrate.sh down NNN}" last file
  ledger_exists || { echo "nothing applied" >&2; exit 1; }
  last="$("${PSQL[@]}" -tAc "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1")"
  [[ "$version" == "$last" ]] || { echo "ERROR: only the last applied version ($last) can be rolled back" >&2; exit 1; }
  file="$(find "$DIR" -maxdepth 1 -name "${version}_*_down.sql" -printf '%f\n' | head -1)"
  [[ -n "$file" ]] || { echo "ERROR: no down file for $version" >&2; exit 1; }
  echo "← reverting $file"
  if [[ "$version" == "000" ]]; then
    # 000 drops the ledger itself, so there is no row to delete afterwards.
    "${PSQL[@]}" --single-transaction -f "$DIR/$file"
  else
    { cat "$DIR/$file"; printf '\n'; cat <<'SQL'
DELETE FROM schema_migrations WHERE version = :'version';
SQL
    } | "${PSQL[@]}" --single-transaction -v version="$version"
  fi
}

case "${1:-up}" in
  up) cmd_up ;;
  status) cmd_status ;;
  down) shift; cmd_down "${1:-}" ;;
  *) echo "usage: $0 [up|status|down NNN]" >&2; exit 2 ;;
esac
