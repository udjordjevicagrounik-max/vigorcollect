#!/usr/bin/env bash
# Post-deploy smoke (release checklist, task 1.7). Exit 0 = all four checks passed.
#   1. /health → 200, status ok, db ok
#   2. /login  → 200 (the app renders)
#   3. tenant query as the app role: with SMOKE_TENANT_ID the tenant's users are visible, without
#      it nothing is (RLS alive)
#   4. worker heartbeat: WORKER_HEALTH_URL, else `docker compose exec worker`, else the queue is
#      not stuck (job_health: oldest pending < 5 min)
# Usage: scripts/smoke.sh [base URL]   (default BETTER_AUTH_URL). Prints results, never secrets.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -f "$ROOT/.env" && -z "${DATABASE_URL:-}" ]]; then
  # shellcheck disable=SC1091
  set -a && source "$ROOT/.env" && set +a
fi
BASE="${1:-${BETTER_AUTH_URL:?base URL or BETTER_AUTH_URL required}}"
BASE="${BASE%/}"
: "${DATABASE_URL:?DATABASE_URL (vigor_app) required}"
: "${SMOKE_TENANT_ID:?SMOKE_TENANT_ID (a tenant with at least one user) required}"
failed=0
ok() { printf 'smoke: ok   %s\n' "$1"; }
bad() { printf 'smoke: FAIL %s\n' "$1" >&2; failed=1; }

health="$(curl -fsS --max-time 10 "$BASE/health" 2>/dev/null || true)"
if [[ -n "$health" ]] && HEALTH="$health" node -e '
    const h = JSON.parse(process.env.HEALTH);
    process.exit(h.status === "ok" && h.db === "ok" ? 0 : 1);'; then
  ok "/health (db ok)"
else
  bad "/health"
fi

code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$BASE/login" || true)"
[[ "$code" == "200" ]] && ok "/login 200" || bad "/login ($code)"

counts="$(psql "$DATABASE_URL" -X -q -At --no-psqlrc -v tenant="$SMOKE_TENANT_ID" 2>/dev/null <<'SQL' || true
BEGIN READ ONLY;
SELECT count(*) FROM users;
SELECT set_config('app.tenant_id', :'tenant', true) IS NOT NULL;
SELECT count(*) FROM users;
COMMIT;
SQL
)"
read -r without _ with <<<"$(echo "$counts" | tr '\n' ' ')"
if [[ "${without:-x}" == "0" && "${with:-0}" =~ ^[0-9]+$ && "${with:-0}" -gt 0 ]]; then
  ok "tenant query (RLS: 0 without tenant, $with with)"
else
  bad "tenant query"
fi

worker_ok=1
if [[ -n "${WORKER_HEALTH_URL:-}" ]]; then
  curl -fsS --max-time 10 "$WORKER_HEALTH_URL" >/dev/null 2>&1 || worker_ok=0
elif command -v docker >/dev/null && docker compose -f "$ROOT/docker-compose.yml" ps --status running worker 2>/dev/null | grep -q worker; then
  docker compose -f "$ROOT/docker-compose.yml" exec -T worker node -e \
    "fetch('http://127.0.0.1:3001/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" || worker_ok=0
else
  oldest="$(psql "$DATABASE_URL" -X -At --no-psqlrc -c 'SELECT coalesce(oldest_pending_seconds, 0) FROM job_health()' 2>/dev/null || echo 999999)"
  [[ "$oldest" =~ ^[0-9]+$ && "$oldest" -lt 300 ]] || worker_ok=0
fi
[[ "$worker_ok" == 1 ]] && ok "worker heartbeat" || bad "worker heartbeat"

exit "$failed"
