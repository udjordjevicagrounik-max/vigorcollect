-- 007_worker_up.sql — Sprint 1, task 1.3: job runner role, outbox access, pg-boss schema.
-- ADR 0002 "Otvoreno" 2. Applied by scripts/migrate.sh as vigor_migrate in one transaction.
-- Protected file (rule 13).
--
-- PRECONDITION: the role vigor_worker exists (scripts/create-worker-role.sh, as superuser —
-- vigor_migrate is NOCREATEROLE). Password from WORKER_DB_PASSWORD, never in this file.
--
-- vigor_worker gets policies ONLY on domain_events and mail_outbox. It never sees tenant data:
-- every event handler runs as vigor_app with SET LOCAL app.tenant_id = event.tenant_id.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vigor_worker') THEN
    RAISE EXCEPTION 'role vigor_worker is missing — run scripts/create-worker-role.sh first (docs/runbook.md)';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vigor_worker' AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'vigor_worker must be NOSUPERUSER NOBYPASSRLS (rule 3)';
  END IF;
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO vigor_worker', current_database());
END $$;

GRANT USAGE ON SCHEMA public TO vigor_worker;

-- ============================================================================================
-- domain_events — the outbox. Worker: read all, advance status, delete old processed rows,
-- never touch payload or tenant.
-- ============================================================================================

GRANT SELECT, DELETE ON domain_events TO vigor_worker;
GRANT UPDATE (status, attempts, last_error, processed_at, updated_at, updated_by)
  ON domain_events TO vigor_worker;

CREATE POLICY worker_read ON domain_events FOR SELECT TO vigor_worker USING (true);
CREATE POLICY worker_advance ON domain_events FOR UPDATE TO vigor_worker
  USING (true) WITH CHECK (true);
-- Retention: processed events older than 90 days.
CREATE POLICY worker_retention ON domain_events FOR DELETE TO vigor_worker
  USING (status = 'processed' AND processed_at < now() - interval '90 days');

-- Status machine: pending → processing → processed | failed | pending (retry); failed → pending
-- (manual re-queue). processed is final. Holds for every role.
CREATE FUNCTION domain_events_status_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'pending'    AND NEW.status = 'processing')
    OR (OLD.status = 'processing' AND NEW.status IN ('processed', 'failed', 'pending'))
    OR (OLD.status = 'failed'     AND NEW.status = 'pending')
  ) THEN
    RAISE EXCEPTION 'domain_events: % → % is not allowed', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER domain_events_status BEFORE UPDATE ON domain_events
  FOR EACH ROW EXECUTE FUNCTION domain_events_status_guard();

-- ============================================================================================
-- mail_outbox — worker: read, advance delivery status of real transports, delete after 7 days.
-- Sink rows stay 'captured' (CHECK mail_outbox_sink_status from 006).
-- ============================================================================================

GRANT SELECT, DELETE ON mail_outbox TO vigor_worker;
GRANT UPDATE (status, sent_at, updated_at, updated_by) ON mail_outbox TO vigor_worker;

-- The rule-24 trigger from 006 reads tenants; the worker has no access there and never changes
-- transport (column grants). Check on INSERT and on a transport change only — same guarantee.
CREATE OR REPLACE FUNCTION mail_outbox_demo_sink_only() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.transport IS NOT DISTINCT FROM OLD.transport THEN
    RETURN NEW;
  END IF;
  IF NEW.transport <> 'sink' AND EXISTS (
    SELECT 1 FROM tenants t WHERE t.id = NEW.tenant_id AND t.is_demo
  ) THEN
    RAISE EXCEPTION 'mail_outbox: a demo tenant sends e-mail only to the sink (rule 24)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE POLICY worker_read ON mail_outbox FOR SELECT TO vigor_worker USING (true);
CREATE POLICY worker_deliver ON mail_outbox FOR UPDATE TO vigor_worker
  USING (transport <> 'sink') WITH CHECK (transport <> 'sink');
CREATE POLICY worker_retention ON mail_outbox FOR DELETE TO vigor_worker
  USING (created_at < now() - interval '7 days');

-- ============================================================================================
-- Tenant clock — (tenant_id, timezone) of active tenants for scheduled jobs (rule 26)
-- ============================================================================================

-- The worker has no policy on tenants / tenant_settings. It calls tenant_clock(), which runs as
-- the owner (vigor_migrate) and opens a read path ONLY inside the function (GUC
-- app.tenant_clock); the owner stays under FORCE RLS everywhere else. Two columns, nothing else.
CREATE POLICY tenant_clock_read ON tenants FOR SELECT TO vigor_migrate
  USING (current_setting('app.tenant_clock', true) = 'on');
CREATE POLICY tenant_clock_read ON tenant_settings FOR SELECT TO vigor_migrate
  USING (current_setting('app.tenant_clock', true) = 'on');

CREATE FUNCTION tenant_clock() RETURNS TABLE (tenant_id uuid, timezone text)
  LANGUAGE plpgsql STABLE
  SECURITY DEFINER
  SET search_path = public, pg_catalog
AS $$
BEGIN
  PERFORM set_config('app.tenant_clock', 'on', true);
  RETURN QUERY
    SELECT t.id, s.timezone
    FROM tenants t JOIN tenant_settings s ON s.tenant_id = t.id
    WHERE t.status = 'active'
    ORDER BY t.id;
  PERFORM set_config('app.tenant_clock', '', true);
END $$;

REVOKE ALL ON FUNCTION tenant_clock() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_clock() TO vigor_worker;

-- ============================================================================================
-- pg-boss — its own schema, managed by pg-boss itself as vigor_worker (library state: job ids,
-- {eventId, tenantId} payloads, no personal data). The app has no access.
-- ============================================================================================

CREATE SCHEMA pgboss;
REVOKE ALL ON SCHEMA pgboss FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA pgboss TO vigor_worker;

-- Aggregates for /health (rule 94): counts and ages only — never payloads. The worker grants
-- SELECT on pgboss.job to vigor_migrate at start (it owns the pg-boss tables); before the first
-- worker start the function answers NULLs.
CREATE FUNCTION job_health()
  RETURNS TABLE (pending integer, failed integer, oldest_pending_seconds integer,
                 last_retention_at timestamptz)
  LANGUAGE plpgsql STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
BEGIN
  RETURN QUERY EXECUTE $q$
    SELECT count(*) FILTER (WHERE state IN ('created', 'retry'))::int,
           count(*) FILTER (WHERE state = 'failed')::int,
           extract(epoch FROM now() - min(created_on) FILTER (
             WHERE state IN ('created', 'retry') AND start_after <= now()))::int,
           max(completed_on) FILTER (WHERE name = 'retention' AND state = 'completed')
    FROM pgboss.job $q$;
EXCEPTION WHEN undefined_table OR insufficient_privilege OR invalid_schema_name THEN
  RETURN QUERY SELECT NULL::int, NULL::int, NULL::int, NULL::timestamptz;
END $$;

REVOKE ALL ON FUNCTION job_health() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION job_health() TO vigor_app, vigor_worker;
