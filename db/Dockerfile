# Postgres 16 with the role bootstrap baked in. The init script is copied (not bind-mounted)
# so the stack works even when the Docker daemon cannot see the repo path.
FROM postgres:16-bookworm
ENV TZ=UTC PGTZ=UTC
COPY --chmod=0755 init/ /docker-entrypoint-initdb.d/
