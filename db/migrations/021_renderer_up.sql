-- 021_renderer_up.sql — review S-10: HTML → PDF in a separate renderer service without secrets.
-- Additive only. Protected (rule 13).
--
-- PRECONDITION: the role vigor_renderer exists (scripts/create-service-roles.sh, as superuser —
-- vigor_migrate is NOCREATEROLE). Password from RENDERER_DB_PASSWORD, never in this file.
--
-- Chromium runs with --no-sandbox (pdf.ts explains why). Before, it ran inside the worker, next to
-- PII_MASTER_KEYS, the backup role (BYPASSRLS) and every other secret. Now the worker writes the
-- HTML of a document into render_jobs, the renderer service (same image, env RENDER_DATABASE_URL
-- only) renders it and writes the PDF back, the worker encrypts and stores the PDF and deletes
-- the row. vigor_renderer can reach exactly this one table — nothing else in the database.
-- A job lives at most 1 hour (CHECK); expired rows are invisible to the renderer and deleted by
-- the worker's retention.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vigor_renderer') THEN
    RAISE EXCEPTION 'role vigor_renderer is missing — run scripts/create-service-roles.sh first (docs/runbook.md)';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vigor_renderer'
             AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb)) THEN
    RAISE EXCEPTION 'vigor_renderer must be NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB (rule 3)';
  END IF;
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO vigor_renderer', current_database());
END $$;

GRANT USAGE ON SCHEMA public TO vigor_renderer;

CREATE TABLE render_jobs (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid        NOT NULL REFERENCES tenants (id),
  -- The generated document (HTML) this job renders; the PDF becomes its rendition.
  document_id  uuid        NOT NULL,
  -- Transient copy of the document HTML: the renderer holds no key, so it is plaintext here,
  -- for at most an hour (CHECK below), deleted by the worker as soon as the PDF is stored.
  html_in      text        NOT NULL CHECK (length(html_in) BETWEEN 1 AND 5000000),
  pdf_out      bytea       CHECK (length(pdf_out) BETWEEN 1 AND 50000000),
  status       text        NOT NULL DEFAULT 'queued'
                           CHECK (status IN ('queued', 'rendering', 'done', 'failed')),
  error        text        CHECK (error ~ '^[a-z][a-z0-9_.]{1,62}$'),
  renderer     text        CHECK (renderer ~ '^[a-z]+/[0-9A-Za-z._-]{1,40}$'),
  expires_at   timestamptz NOT NULL DEFAULT now() + interval '1 hour',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT render_jobs_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT render_jobs_document FOREIGN KEY (tenant_id, document_id) REFERENCES documents (tenant_id, id),
  CONSTRAINT render_jobs_lifetime CHECK (expires_at <= created_at + interval '1 hour'),
  CONSTRAINT render_jobs_done CHECK ((status = 'done') = (pdf_out IS NOT NULL)),
  CONSTRAINT render_jobs_failed CHECK ((status = 'failed') = (error IS NOT NULL))
);
CREATE INDEX render_jobs_queued ON render_jobs (created_at) WHERE status = 'queued';

CREATE TRIGGER render_jobs_updated_at BEFORE UPDATE ON render_jobs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Status machine for every role: queued → rendering → done | failed. Input and tenant never change.
CREATE FUNCTION render_jobs_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.document_id <> OLD.document_id
     OR NEW.html_in <> OLD.html_in OR NEW.expires_at <> OLD.expires_at
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'render_jobs: the job input is frozen' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'queued'    AND NEW.status = 'rendering')
    OR (OLD.status = 'rendering' AND NEW.status IN ('done', 'failed'))
  ) THEN
    RAISE EXCEPTION 'render_jobs: % → % is not allowed', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER render_jobs_guard BEFORE UPDATE ON render_jobs
  FOR EACH ROW EXECUTE FUNCTION render_jobs_guard();

ALTER TABLE render_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE render_jobs FORCE ROW LEVEL SECURITY;
-- The app (worker handlers as vigor_app): its own tenant only.
CREATE POLICY tenant_isolation ON render_jobs
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
-- The renderer has no tenant context: it sees live jobs of every tenant (it renders them) and
-- nothing else anywhere — no grant on any other table.
CREATE POLICY renderer_read ON render_jobs FOR SELECT TO vigor_renderer
  USING (expires_at > now());
CREATE POLICY renderer_work ON render_jobs FOR UPDATE TO vigor_renderer
  USING (expires_at > now() AND status IN ('queued', 'rendering'))
  WITH CHECK (status IN ('rendering', 'done', 'failed'));
GRANT SELECT (id, html_in, status, expires_at, created_at) ON render_jobs TO vigor_renderer;
GRANT UPDATE (status, pdf_out, error, renderer) ON render_jobs TO vigor_renderer;

-- Worker retention: expired jobs (a worker that died before deleting its row).
GRANT DELETE ON render_jobs TO vigor_worker;
CREATE POLICY worker_retention ON render_jobs FOR DELETE TO vigor_worker
  USING (expires_at < now());
GRANT SELECT (expires_at) ON render_jobs TO vigor_worker;
CREATE POLICY worker_read_expiry ON render_jobs FOR SELECT TO vigor_worker
  USING (expires_at < now());

INSERT INTO pii_field_registry (table_name, column_name, pii_class, encrypted, exception_reason, purpose)
VALUES
  ('render_jobs', 'html_in', 'P3', false, 'transient render input, at most 1 hour, renderer holds no key',
   'document HTML handed to the renderer service (review S-10)'),
  ('render_jobs', 'pdf_out', 'P3', false, 'transient render output, at most 1 hour, renderer holds no key',
   'PDF handed back to the worker, which encrypts and stores it (review S-10)');
INSERT INTO pii_field_registry (table_name, column_name, pii_class, purpose)
SELECT c.table_name, c.column_name, 'P0', 'not personal data (registered by 021)'
FROM information_schema.columns c
WHERE c.table_schema = 'public' AND c.table_name = 'render_jobs'
  AND c.column_name NOT IN ('html_in', 'pdf_out');
