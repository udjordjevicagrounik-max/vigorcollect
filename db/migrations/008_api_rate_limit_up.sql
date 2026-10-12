-- 008_api_rate_limit_up.sql — Sprint 1, task 1.4: generic per-IP rate limit for our API.
-- Better Auth limits its own routes (auth."rateLimit"); this table covers every other /api route
-- and is shared by all app instances. Applied by scripts/migrate.sh as vigor_migrate in one
-- transaction. Protected file (rule 13).

-- Platform table (no tenant: a request is limited before anyone is known).
CREATE TABLE api_rate_limit (
  key           text        PRIMARY KEY CHECK (key <> '' AND length(key) <= 200),
  window_start  timestamptz NOT NULL DEFAULT now(),
  hits          integer     NOT NULL DEFAULT 1 CHECK (hits >= 0)
);

ALTER TABLE api_rate_limit ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_rate_limit FORCE ROW LEVEL SECURITY;
CREATE POLICY app_all ON api_rate_limit TO vigor_app USING (true) WITH CHECK (true);
CREATE POLICY migrate_all ON api_rate_limit TO vigor_migrate USING (true) WITH CHECK (true);
REVOKE TRUNCATE, REFERENCES, TRIGGER ON api_rate_limit FROM vigor_app;

-- One atomic step: count this hit in the current fixed window (a new window resets the count).
-- allowed = hits <= p_max; retry_after = seconds until the window ends.
CREATE FUNCTION api_rate_limit_hit(p_key text, p_window_seconds integer, p_max integer)
  RETURNS TABLE (allowed boolean, retry_after integer)
  LANGUAGE sql
  SET search_path = public, pg_catalog
AS $$
  INSERT INTO api_rate_limit AS r (key, window_start, hits)
  VALUES (p_key, now(), 1)
  ON CONFLICT (key) DO UPDATE SET
    window_start = CASE WHEN r.window_start <= now() - make_interval(secs => p_window_seconds)
                        THEN now() ELSE r.window_start END,
    hits = CASE WHEN r.window_start <= now() - make_interval(secs => p_window_seconds)
                THEN 1 ELSE r.hits + 1 END
  RETURNING r.hits <= p_max,
            greatest(1, ceil(extract(epoch FROM r.window_start
                                 + make_interval(secs => p_window_seconds) - now())))::int
$$;

REVOKE ALL ON FUNCTION api_rate_limit_hit(text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api_rate_limit_hit(text, integer, integer) TO vigor_app;

INSERT INTO pii_field_registry
  (table_name, column_name, pii_class, conditional_on, conditional_pii_class, encrypted, exception_reason, purpose)
VALUES
  ('api_rate_limit', 'key', 'P1', NULL, NULL, false,
   'security telemetry (client IP); reset every window, old rows removed by retention', 'per-IP request limit');

INSERT INTO pii_field_registry (table_name, column_name, pii_class, purpose)
SELECT c.table_name, c.column_name, 'P0', 'not personal data (registered by 008)'
FROM information_schema.columns c
WHERE c.table_schema = 'public' AND c.table_name = 'api_rate_limit'
ON CONFLICT (table_name, column_name) DO NOTHING;
