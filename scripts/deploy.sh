#!/usr/bin/env bash
# Build and start the app stack with the git commit as its version: every deploy shows the commit
# in X-App-Version (and Sentry release). Never `docker compose restart` (old image).
#
#   scripts/deploy.sh                 app worker renderer
#   scripts/deploy.sh app             only the listed services
#
# Uncommitted changes → version "<rev>-dirty", so a build that is not a commit is visible.
# Migrations stay a separate step before this one (./scripts/migrate.sh up, runbook "Migracije").
# Prints the version and the health check — never a secret.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

APP_VERSION="$(git rev-parse --short HEAD)"
[[ -n "$(git status --porcelain --untracked-files=no)" ]] && APP_VERSION="${APP_VERSION}-dirty"
export APP_VERSION
services=("$@")
[[ ${#services[@]} -eq 0 ]] && services=(app worker renderer)

printf 'deploy: %s → %s\n' "$APP_VERSION" "${services[*]}"
docker compose up -d --build "${services[@]}"

# Wait for the app's health (2 min), then show what it serves.
port="$(docker compose port app 3000 2>/dev/null || true)"
[[ -z "$port" ]] && { echo "deploy: app port not published — check: docker compose ps"; exit 0; }
for _ in $(seq 1 60); do
  served="$(curl -fsS -o /dev/null -D - "http://$port/health" 2>/dev/null | tr -d '\r' |
    awk -F': ' 'tolower($1) == "x-app-version" { print $2 }')"
  [[ "$served" == "$APP_VERSION" ]] && { printf 'deploy: ok — X-App-Version %s\n' "$served"; exit 0; }
  sleep 2
done
printf 'deploy: app serves "%s", expected "%s" — docker compose logs app --since 5m\n' "${served:-none}" "$APP_VERSION" >&2
exit 1
