-- 025_reports_exports_digest_up.sql — Sprint 5.2: exports, reports, settings, digests.
-- Protected (rule 13). Additive except two CHECKs on mail_outbox replaced by supersets under the
-- same names (ADR 0003, "Zamena CHECK-a"); no data changes.
--
-- export_files: an export of more than the synchronous limit (or a bulk export) is produced by
--   the worker into the documents storage (sealed per tenant, storage_ref is never a URL) and
--   leaves only through exportService, which writes export_log on download (rule 12).
-- saved_reports: report filters / columns / sort per member, optionally shared in the tenant.
-- notification_preferences + digest_runs: daily "My day" and weekly manager digest per member,
--   once per member and LOCAL date (users.timezone, rule 26) — digest_runs is the idempotency key.
-- Working days and holidays per company (rule 26): tenant_companies.working_days (ISO 1 = Monday)
--   and company_holidays; is_working_day() is the single place that reads them.

-- ============================================================================================
-- Exports
-- ============================================================================================
CREATE TABLE export_files (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid        NOT NULL REFERENCES tenants (id),
  export_type    text        NOT NULL CHECK (export_type ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'),
  format         text        NOT NULL CHECK (format IN ('csv', 'xlsx')),
  status         text        NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'ready', 'failed')),
  -- The filter that produced it: ids / codes / dates only (P0, ADR 0003).
  filters        jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(filters) = 'object'),
  row_count      integer     CHECK (row_count >= 0),
  size_bytes     integer     CHECK (size_bytes > 0),
  file_sha256    bytea       CHECK (octet_length(file_sha256) = 32),
  storage_ref    text        CHECK (storage_ref ~ '^[a-z]+:[A-Za-z0-9/_.-]{1,250}$'),
  key_version    integer     CHECK (key_version >= 1),
  error_code     text        CHECK (error_code ~ '^[a-z][a-z0-9_.]{1,62}$'),
  requested_by   uuid        NOT NULL,
  request_id     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  expires_at     timestamptz NOT NULL DEFAULT now() + interval '7 days',
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT export_files_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT export_files_requested_by FOREIGN KEY (tenant_id, requested_by) REFERENCES users (tenant_id, id),
  CONSTRAINT export_files_ready CHECK ((status = 'ready') = (storage_ref IS NOT NULL AND key_version IS NOT NULL
                                                             AND file_sha256 IS NOT NULL AND row_count IS NOT NULL)),
  CONSTRAINT export_files_finished CHECK ((status IN ('ready', 'failed')) = (finished_at IS NOT NULL))
);
CREATE INDEX export_files_requester ON export_files (tenant_id, requested_by, created_at DESC);
CREATE TRIGGER export_files_updated_at BEFORE UPDATE ON export_files
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================================================
-- Saved reports
-- ============================================================================================
CREATE TABLE saved_reports (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid        NOT NULL REFERENCES tenants (id),
  owner_user_id  uuid        NOT NULL,
  report_key     text        NOT NULL CHECK (report_key IN ('aging_by_customer', 'aging_by_collector',
                                                            'collected_by_period', 'promises',
                                                            'cases_by_stage', 'disputes')),
  name           text        NOT NULL CHECK (btrim(name) <> '' AND length(name) <= 120),
  -- filters, columns, sort: codes / ids / dates only (P0).
  config         jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(config) = 'object'),
  shared         boolean     NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid,
  updated_by     uuid,
  CONSTRAINT saved_reports_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT saved_reports_owner FOREIGN KEY (tenant_id, owner_user_id) REFERENCES users (tenant_id, id),
  CONSTRAINT saved_reports_name UNIQUE (tenant_id, owner_user_id, report_key, name)
);
CREATE TRIGGER saved_reports_updated_at BEFORE UPDATE ON saved_reports
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================================================
-- Notification preferences and digests
-- ============================================================================================
CREATE TABLE notification_preferences (
  tenant_id         uuid        NOT NULL REFERENCES tenants (id),
  user_id           uuid        NOT NULL,
  daily_digest      boolean     NOT NULL DEFAULT true,
  -- Sent only to members holding report.read (manager view of their scope).
  weekly_digest     boolean     NOT NULL DEFAULT true,
  in_app_attention  boolean     NOT NULL DEFAULT true,
  in_app_mail       boolean     NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id),
  CONSTRAINT notification_preferences_user FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id)
);
CREATE TRIGGER notification_preferences_updated_at BEFORE UPDATE ON notification_preferences
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE digest_runs (
  tenant_id       uuid        NOT NULL REFERENCES tenants (id),
  user_id         uuid        NOT NULL,
  kind            text        NOT NULL CHECK (kind IN ('daily', 'weekly')),
  local_date      date        NOT NULL,
  mail_outbox_id  uuid,
  -- 'sent' or why not ('empty' = nothing to report, no mail).
  outcome         text        NOT NULL CHECK (outcome IN ('sent', 'empty')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, kind, local_date),
  CONSTRAINT digest_runs_user FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id),
  CONSTRAINT digest_runs_sent CHECK ((outcome = 'sent') = (mail_outbox_id IS NOT NULL))
);

-- mail_outbox.kind 'digest': to the member's own address; no customer, no template.
ALTER TABLE mail_outbox DROP CONSTRAINT mail_outbox_kind_check;
ALTER TABLE mail_outbox ADD CONSTRAINT mail_outbox_kind_check
  CHECK (kind IN ('invitation', 'password_reset', 'reminder', 'dunning', 'statement', 'document',
                  'reply', 'test', 'digest'));
ALTER TABLE mail_outbox DROP CONSTRAINT mail_outbox_collection_refs;
ALTER TABLE mail_outbox ADD CONSTRAINT mail_outbox_collection_refs
  CHECK ((kind IN ('invitation', 'password_reset', 'test', 'digest')) = (customer_id IS NULL AND template_id IS NULL));

-- ============================================================================================
-- Working days and holidays per company (rule 26)
-- ============================================================================================
ALTER TABLE tenant_companies
  ADD COLUMN working_days smallint[] NOT NULL DEFAULT '{1,2,3,4,5}'
    CHECK (cardinality(working_days) BETWEEN 1 AND 7 AND working_days <@ '{1,2,3,4,5,6,7}'::smallint[]);

CREATE TABLE company_holidays (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid        NOT NULL REFERENCES tenants (id),
  company_id    uuid        NOT NULL,
  holiday_date  date        NOT NULL,
  name          text        NOT NULL CHECK (btrim(name) <> '' AND length(name) <= 120),
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  CONSTRAINT company_holidays_company FOREIGN KEY (tenant_id, company_id) REFERENCES tenant_companies (tenant_id, id),
  CONSTRAINT company_holidays_once UNIQUE (tenant_id, company_id, holiday_date)
);

CREATE FUNCTION is_working_day(p_company uuid, p_date date) RETURNS boolean
  LANGUAGE sql STABLE
  SET search_path = public, pg_catalog
AS $$
  SELECT EXISTS (SELECT 1 FROM tenant_companies c
                 WHERE c.id = p_company AND extract(isodow FROM p_date)::smallint = ANY (c.working_days))
     AND NOT EXISTS (SELECT 1 FROM company_holidays h
                     WHERE h.company_id = p_company AND h.holiday_date = p_date);
$$;

-- ============================================================================================
-- RLS, grants, PII registry
-- ============================================================================================
ALTER TABLE export_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE export_files FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON export_files
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE saved_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE saved_reports FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON saved_reports
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_preferences FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notification_preferences
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE digest_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE digest_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON digest_runs
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE company_holidays ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_holidays FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON company_holidays
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

REVOKE TRUNCATE ON export_files, saved_reports, notification_preferences, company_holidays FROM vigor_app;
REVOKE DELETE, TRUNCATE ON digest_runs FROM vigor_app;

INSERT INTO pii_field_registry (table_name, column_name, pii_class, purpose)
SELECT c.table_name, c.column_name, 'P0', 'not personal data (registered by 025)'
FROM information_schema.columns c
WHERE c.table_schema = 'public'
  AND c.table_name IN ('export_files', 'saved_reports', 'notification_preferences', 'digest_runs',
                       'company_holidays');
INSERT INTO pii_field_registry (table_name, column_name, pii_class, purpose)
VALUES ('tenant_companies', 'working_days', 'P0', 'not personal data (registered by 025)');
