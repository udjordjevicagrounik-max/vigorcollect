-- 010_ops_up.sql — Sprint 1, task 1.7: operations records (backup, restore test) and the
-- platform time zone for alarms. Applied by scripts/migrate.sh as vigor_migrate in one
-- transaction. Protected file (rule 13).

-- Platform table (no tenant): written ONLY by scripts/backup.sh and scripts/restore-test.sh
-- with the backup credentials (superuser — pg_dump must read past FORCE RLS); the app reads it
-- for Admin → System status and the worker's alarms. Details: sizes, counts, file names,
-- error codes — never data.
CREATE TABLE ops_runs (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         text        NOT NULL CHECK (kind IN ('backup', 'restore_test')),
  status       text        NOT NULL CHECK (status IN ('ok', 'failed')),
  started_at   timestamptz NOT NULL,
  finished_at  timestamptz NOT NULL,
  details      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ops_runs_order CHECK (finished_at >= started_at)
);
CREATE INDEX ops_runs_kind_finished ON ops_runs (kind, finished_at DESC);

ALTER TABLE ops_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY app_read ON ops_runs FOR SELECT TO vigor_app USING (true);
CREATE POLICY migrate_all ON ops_runs TO vigor_migrate USING (true) WITH CHECK (true);
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ops_runs FROM vigor_app;

-- Time zone of tenant #0 (platform operator) — "backup not done by 06:00 local" (rule 26).
-- Same read path as tenant_clock() (007): the owner's policy opens only inside the function.
CREATE FUNCTION platform_timezone() RETURNS text
  LANGUAGE plpgsql STABLE
  SECURITY DEFINER
  SET search_path = public, pg_catalog
AS $$
DECLARE
  tz text;
BEGIN
  PERFORM set_config('app.tenant_clock', 'on', true);
  SELECT s.timezone INTO tz
  FROM tenants t JOIN tenant_settings s ON s.tenant_id = t.id
  WHERE t.is_platform_operator;
  PERFORM set_config('app.tenant_clock', '', true);
  RETURN coalesce(tz, 'UTC');
END $$;

REVOKE ALL ON FUNCTION platform_timezone() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_timezone() TO vigor_app, vigor_worker;

INSERT INTO pii_field_registry
  (table_name, column_name, pii_class, conditional_on, conditional_pii_class, encrypted, exception_reason, purpose)
VALUES
  ('ops_runs', 'details', 'P0', NULL, NULL, false, NULL, 'sizes, counts, file names, error codes of an ops run');

INSERT INTO pii_field_registry (table_name, column_name, pii_class, purpose)
SELECT c.table_name, c.column_name, 'P0', 'not personal data (registered by 010)'
FROM information_schema.columns c
WHERE c.table_schema = 'public' AND c.table_name = 'ops_runs'
ON CONFLICT (table_name, column_name) DO NOTHING;
