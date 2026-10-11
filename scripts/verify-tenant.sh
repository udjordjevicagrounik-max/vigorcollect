#!/usr/bin/env bash
# Tenant-isolation verification (Definition of Done, CLAUDE.md).
# Stub for 0.1: passes on an empty project. TODO(1.6): full implementation —
#   1. connect as vigor_app and assert rolsuper = false AND rolbypassrls = false
#   2. every table with a tenant_id column has relrowsecurity = true and >= 1 policy
#   3. cross-tenant probe: SET LOCAL app.tenant_id = A, then read B's rows → 0 rows
#   4. static scan: no tenant_id taken from body/query/header/URL in src/server (rule 2)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fail=0

# Static check available today: tenant_id must never be read from request input (rule 2).
if grep -rEn "(searchParams|params|body|headers)[^;]*tenant_?[iI]d" "$ROOT/src" --include='*.ts' --include='*.tsx' 2>/dev/null; then
  echo "verify-tenant: tenant_id read from request input (rule 2)" >&2
  fail=1
fi

echo "verify-tenant: static checks passed; DB checks pending (TODO 1.6)."
exit "$fail"
