-- 007_worker_down.sql — reverts 007_worker_up.sql (dev/test only, rule 15).
-- The role vigor_worker itself stays (cluster-wide, created outside migrations); the pg-boss
-- schema and all its jobs are dropped.

DROP FUNCTION job_health();
DROP SCHEMA pgboss CASCADE;

DROP FUNCTION tenant_clock();
DROP POLICY tenant_clock_read ON tenant_settings;
DROP POLICY tenant_clock_read ON tenants;

-- Restore the 006 body of the rule-24 trigger function.
CREATE OR REPLACE FUNCTION mail_outbox_demo_sink_only() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
BEGIN
  IF NEW.transport <> 'sink' AND EXISTS (
    SELECT 1 FROM tenants t WHERE t.id = NEW.tenant_id AND t.is_demo
  ) THEN
    RAISE EXCEPTION 'mail_outbox: a demo tenant sends e-mail only to the sink (rule 24)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP POLICY worker_retention ON mail_outbox;
DROP POLICY worker_deliver ON mail_outbox;
DROP POLICY worker_read ON mail_outbox;
REVOKE ALL ON mail_outbox FROM vigor_worker;

DROP TRIGGER domain_events_status ON domain_events;
DROP FUNCTION domain_events_status_guard();
DROP POLICY worker_retention ON domain_events;
DROP POLICY worker_advance ON domain_events;
DROP POLICY worker_read ON domain_events;
REVOKE ALL ON domain_events FROM vigor_worker;

REVOKE USAGE ON SCHEMA public FROM vigor_worker;
DO $$
BEGIN
  EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM vigor_worker', current_database());
END $$;
