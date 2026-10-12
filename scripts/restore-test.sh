#!/usr/bin/env bash
# Weekly restore test (rule 28; task 1.7) — worker Sunday 03:00 UTC, or by hand.
# Restores the latest daily dump of the main database into <db>_restore_test, then compares
# every table's row count with the counts INSIDE the dump (COPY blocks) — no race with live
# writes. Result → ops_runs; the copy is dropped afterwards.
set -euo pipefail
OPS_URL_VAR=RESTORE_DATABASE_URL # vigor_restore — never the superuser
# shellcheck source=lib/pg-admin.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/pg-admin.sh"

STARTED="$(date -u +%FT%TZ)"
TARGET="${MAIN_DB}_restore_test"
step="locate"

fail() {
  record_ops_run restore_test failed "$STARTED" "{\"step\":\"$step\"}"
  dropdb --if-exists --no-password "$TARGET" >/dev/null 2>&1 || true
  echo "restore-test: FAILED at step $step" >&2
  exit 1
}
trap fail ERR

LATEST="$(find "$BACKUP_DIR/daily" -mindepth 1 -maxdepth 1 -type d ! -name '*.partial' -printf '%f\n' | sort | tail -1)"
[[ -n "$LATEST" ]] || { step="no-backup"; false; }
DUMP="$BACKUP_DIR/daily/$LATEST/db-$MAIN_DB.dump"
[[ -f "$DUMP" ]] || { step="no-dump"; false; }

step="restore"
dropdb --if-exists --no-password "$TARGET"
createdb --no-password "$TARGET"
# vigor_restore owns the scratch database: objects become its own (no owner/grant replay);
# BYPASSRLS lets it count rows through FORCE RLS.
pg_restore --exit-on-error --no-owner --no-privileges --no-password -d "$TARGET" "$DUMP"

step="compare"
EXPECTED="$(mktemp)"
ACTUAL="$(mktemp)"
trap 'rm -f "$EXPECTED" "$ACTUAL"' EXIT
# Rows per table as written in the dump: lines between "COPY schema.table (" and "\.".
pg_restore --data-only -f - "$DUMP" | awk '
  /^COPY [^ ]+ / { table = $2; rows = 0; inside = 1; next }
  inside && $0 == "\\." { print table "\t" rows; inside = 0; next }
  inside { rows++ }' | sed 's/"//g' | sort >"$EXPECTED"
psql -X -At --no-psqlrc -d "$TARGET" -v ON_ERROR_STOP=1 <<'SQL' | sort >"$ACTUAL"
SELECT format('SELECT %L || E''\t'' || count(*) FROM %I.%I', n.nspname || '.' || c.relname, n.nspname, c.relname)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
-- Leaf tables only (partitions included, partitioned parents excluded): COPY writes leaves.
WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
ORDER BY 1 \gexec
SQL
TABLES="$(wc -l <"$EXPECTED" | tr -d ' ')"
ROWS="$(awk -F'\t' '{ s += $2 } END { print s + 0 }' "$EXPECTED")"
MISMATCHES="$(comm -3 "$EXPECTED" "$ACTUAL" | grep -c . || true)"

step="cleanup"
dropdb --no-password "$TARGET"
trap - ERR

if [[ "$MISMATCHES" != "0" || "$TABLES" == "0" ]]; then
  record_ops_run restore_test failed "$STARTED" \
    "{\"backup_day\":\"$LATEST\",\"tables\":$TABLES,\"rows\":$ROWS,\"mismatches\":$MISMATCHES}"
  echo "restore-test: FAILED — $MISMATCHES table(s) differ (backup $LATEST)" >&2
  exit 1
fi
record_ops_run restore_test ok "$STARTED" \
  "{\"backup_day\":\"$LATEST\",\"tables\":$TABLES,\"rows\":$ROWS,\"mismatches\":0}"
echo "restore-test: ok — backup $LATEST, $TABLES tables, $ROWS rows match"
