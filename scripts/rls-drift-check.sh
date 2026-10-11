#!/usr/bin/env bash
# RLS drift check: policies in the live DB must match those declared in db/migrations.
# Stub for 0.1: passes on an empty project. TODO(1.6): full implementation —
#   1. dump pg_policies + relrowsecurity/relforcerowsecurity from the target DB
#   2. compare against policies parsed from db/migrations/*_up.sql
#   3. fail on any table with tenant_id that has RLS disabled or a policy not in migrations
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
count=0
if [[ -d "$ROOT/db/migrations" ]]; then
  count="$(find "$ROOT/db/migrations" -maxdepth 1 -name '*_up.sql' | wc -l)"
fi

echo "rls-drift-check: $count up-migration(s) found; live-DB comparison pending (TODO 1.6)."
exit 0
