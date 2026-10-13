-- 021_renderer_down.sql — reverts 021_renderer_up.sql (dev/test only, rule 15). Deletes queued
-- render jobs (transient by design). The role vigor_renderer stays (cluster object).

DELETE FROM pii_field_registry WHERE table_name = 'render_jobs';
DROP TABLE IF EXISTS render_jobs;
DROP FUNCTION IF EXISTS render_jobs_guard();
REVOKE USAGE ON SCHEMA public FROM vigor_renderer;
DO $$
BEGIN
  EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM vigor_renderer', current_database());
END $$;
