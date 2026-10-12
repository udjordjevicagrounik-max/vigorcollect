# Node version must match .nvmrc and package.json "engines".
ARG NODE_IMAGE=node:22.23.3-bookworm-slim

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --ignore-scripts

FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# Runtime: only the standalone output (server.js + node_modules traced from imports).
# No npm install here, so no devDependencies can reach the image.
FROM ${NODE_IMAGE} AS runner
WORKDIR /app
ARG APP_VERSION=dev
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    TZ=UTC \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    APP_VERSION=${APP_VERSION}
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
USER node
EXPOSE 3000
CMD ["node", "server.js"]

# Worker (ADR 0005, task 1.7 close-out): the same app image plus the tools for the nightly
# backup and the weekly restore test — pg_dump/pg_restore 16 (PGDG, = server major) and rclone
# for the off-site copy. Pinned; when PGDG publishes a newer 16.x the old one leaves its main
# repo — bump PG_CLIENT_VERSION then (docs/runbook.md "Worker image").
FROM runner AS worker
ARG PG_CLIENT_VERSION=16.15-1.pgdg12+2
ARG RCLONE_VERSION=1.60.1+dfsg-2+b5
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
 && install -d -m 0755 /etc/apt/keyrings \
 && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
      | gpg --dearmor -o /etc/apt/keyrings/pgdg.gpg \
 && echo "deb [signed-by=/etc/apt/keyrings/pgdg.gpg] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      "postgresql-client-16=${PG_CLIENT_VERSION}" "rclone=${RCLONE_VERSION}" \
 && apt-get purge -y curl gnupg && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/* \
 && install -d -o node -g node -m 0700 /srv/backups
USER node
ENV PROCESS_ROLE=worker BACKUP_DIR=/srv/backups
CMD ["node", "worker.mjs"]

# Default target (no --target): the web app — the worker stage above must never be the default.
FROM runner AS app
