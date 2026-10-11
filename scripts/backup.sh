#!/usr/bin/env bash
# Nightly backup (rule 28): pg_dump + object storage sync + encrypted config export, off-site.
# Stub for 0.1. TODO(1.6):
#   - pg_dump -Fc via MIGRATE_DATABASE_URL to $BACKUP_DIR/db-<UTC timestamp>.dump
#   - sync object storage (attachments, PDFs) to the same off-site target, same retention
#   - .env lives encrypted in the vault — never inside the backup
#   - restore test restores files as well as tables
set -euo pipefail

echo "backup: not implemented yet (TODO 1.6) — no data was written."
exit 0
