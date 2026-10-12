#!/usr/bin/env bash
# Nightly backup (rule 28; task 1.7) — run as cron on the host or by the worker (02:00 UTC).
#   - pg_dump -Fc of EVERY database the backup role may connect to (not templates, not restore
#     copies) as vigor_backup (pg_read_all_data + BYPASSRLS, no writes), roles WITHOUT passwords;
#   - the repository as a git bundle (committed files only — .env and keys are never committed;
#     checked below);
#   - layout: $BACKUP_DIR/daily/YYYY-MM-DD (30 kept) and monthly/YYYY-MM (12 kept, hardlinks);
#   - off-site sync when BACKUP_S3_BUCKET is set AND rclone or aws cli is installed;
#   - result → ops_runs (Admin → System status, alarms). Secrets are never printed or stored.
set -euo pipefail
OPS_URL_VAR=BACKUP_DATABASE_URL # vigor_backup — never the superuser
# shellcheck source=lib/pg-admin.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/pg-admin.sh"

STARTED="$(date -u +%FT%TZ)"
DAY="$(date -u +%F)"
MONTH="$(date -u +%Y-%m)"
WORK="$BACKUP_DIR/daily/$DAY.partial"
step="start"

fail() {
  record_ops_run backup failed "$STARTED" "{\"step\":\"$step\",\"day\":\"$DAY\"}"
  rm -rf "$WORK"
  echo "backup: FAILED at step $step" >&2
  exit 1
}
trap fail ERR

umask 077
rm -rf "$WORK"
mkdir -p "$WORK" "$BACKUP_DIR/monthly"

step="databases"
# A failed listing must fail the backup (process substitution would hide the exit code), and a
# backup without the main database is no backup.
DB_LIST="$(psql -X -At --no-psqlrc -v ON_ERROR_STOP=1 -c \
  "SELECT datname FROM pg_database WHERE NOT datistemplate AND datname <> 'postgres'
     AND datname NOT LIKE '%\_restore\_test' AND has_database_privilege(datname, 'CONNECT')
   ORDER BY 1")"
mapfile -t DBS <<<"$DB_LIST"
step="databases:main-missing"
printf '%s\n' "${DBS[@]}" | grep -qx "$MAIN_DB"
for db in "${DBS[@]}"; do
  step="dump:$db"
  pg_dump -Fc --no-password -d "$db" -f "$WORK/db-$db.dump"
done
step="globals"
pg_dumpall --globals-only --no-role-passwords --no-password -f "$WORK/globals.sql"

step="repo"
if git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  # Rule 28: secrets never travel with the backup. A tracked .env (other than the example) or a
  # key file stops the backup.
  if git -C "$ROOT" ls-files | grep -Eq '(^|/)\.env($|\.(local|production|development))|\.(pem|key)$'; then
    step="repo:secret-tracked"
    false
  fi
  git -C "$ROOT" bundle create "$WORK/repo.bundle" --all >/dev/null 2>&1
  HEAD="$(git -C "$ROOT" rev-parse --short HEAD)"
else
  HEAD="none"
fi

step="manifest"
WORK="$WORK" HEAD="$HEAD" node -e '
  const fs = require("fs"), path = require("path"), crypto = require("crypto");
  const dir = process.env.WORK;
  const files = fs.readdirSync(dir).filter((f) => !f.startsWith(".")).sort().map((name) => {
    const buf = fs.readFileSync(path.join(dir, name));
    return { name, bytes: buf.length, sha256: crypto.createHash("sha256").update(buf).digest("hex") };
  });
  fs.writeFileSync(path.join(dir, "manifest.json"),
    JSON.stringify({ created: new Date().toISOString(), git: process.env.HEAD, files }, null, 2));'

step="publish"
rm -rf "$BACKUP_DIR/daily/$DAY"
mv "$WORK" "$BACKUP_DIR/daily/$DAY"
WORK=""
if [[ ! -d "$BACKUP_DIR/monthly/$MONTH" ]]; then
  cp -al "$BACKUP_DIR/daily/$DAY" "$BACKUP_DIR/monthly/$MONTH"
fi

step="retention"
prune() { # $1 dir, $2 keep newest N
  local dirs=()
  mapfile -t dirs < <(find "$1" -mindepth 1 -maxdepth 1 -type d ! -name '*.partial' -printf '%f\n' | sort)
  local excess=$(( ${#dirs[@]} - $2 ))
  for (( i = 0; i < excess; i++ )); do rm -rf "${1:?}/${dirs[$i]}"; done
}
prune "$BACKUP_DIR/daily" 30
prune "$BACKUP_DIR/monthly" 12

step="offsite"
OFFSITE="not_configured"
if [[ -n "${BACKUP_S3_BUCKET:-}" ]]; then
  if command -v rclone >/dev/null; then
    RCLONE_CONFIG_OFFSITE_TYPE=s3 RCLONE_CONFIG_OFFSITE_PROVIDER=Other \
      RCLONE_CONFIG_OFFSITE_ENDPOINT="${BACKUP_S3_ENDPOINT:-}" \
      RCLONE_CONFIG_OFFSITE_ACCESS_KEY_ID="${BACKUP_S3_ACCESS_KEY_ID:-}" \
      RCLONE_CONFIG_OFFSITE_SECRET_ACCESS_KEY="${BACKUP_S3_SECRET_ACCESS_KEY:-}" \
      RCLONE_CONFIG_OFFSITE_REGION="${BACKUP_S3_REGION:-auto}" \
      rclone sync --quiet "$BACKUP_DIR" "offsite:$BACKUP_S3_BUCKET/${BACKUP_S3_PREFIX:-backups}"
    OFFSITE="rclone"
  elif command -v aws >/dev/null; then
    AWS_ACCESS_KEY_ID="${BACKUP_S3_ACCESS_KEY_ID:-}" AWS_SECRET_ACCESS_KEY="${BACKUP_S3_SECRET_ACCESS_KEY:-}" \
      AWS_DEFAULT_REGION="${BACKUP_S3_REGION:-auto}" \
      aws s3 sync --only-show-errors --delete ${BACKUP_S3_ENDPOINT:+--endpoint-url "$BACKUP_S3_ENDPOINT"} \
      "$BACKUP_DIR" "s3://$BACKUP_S3_BUCKET/${BACKUP_S3_PREFIX:-backups}"
    OFFSITE="aws"
  else
    OFFSITE="skipped_no_client"
  fi
fi

trap - ERR
BYTES="$(du -sb "$BACKUP_DIR/daily/$DAY" | cut -f1)"
record_ops_run backup ok "$STARTED" \
  "{\"day\":\"$DAY\",\"databases\":${#DBS[@]},\"bytes\":$BYTES,\"offsite\":\"$OFFSITE\",\"git\":\"$HEAD\"}"
echo "backup: ok — $DAY, ${#DBS[@]} database(s), $BYTES bytes, off-site: $OFFSITE"
