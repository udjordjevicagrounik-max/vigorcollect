-- 013_imports_up.sql — Sprint 2, task 2.2 (import of invoices from CSV / XLSX) and 2.3 (saved
-- filters). Applied by scripts/migrate.sh as vigor_migrate in one transaction. Protected file.
--
-- Flow: upload → column detection → mapping (template per tenant + source) → row validation →
-- preview → confirm → worker job (domain event import.confirmed) → report. The uploaded rows are
-- stored only encrypted (HKDF key per tenant, like mail_outbox) and dropped once the run ends.
-- Row errors hold codes only, never cell values (they may contain personal data).

CREATE TABLE import_runs (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid        NOT NULL REFERENCES tenants (id),
  source_id           uuid        NOT NULL,
  company_id          uuid        NOT NULL,
  kind                text        NOT NULL DEFAULT 'invoices' CHECK (kind IN ('invoices')),
  file_format         text        NOT NULL CHECK (file_format IN ('csv', 'xlsx')),
  file_sha256         bytea       NOT NULL CHECK (length(file_sha256) = 32),
  status              text        NOT NULL DEFAULT 'uploaded'
                                  CHECK (status IN ('uploaded', 'validated', 'confirmed', 'completed',
                                                    'failed', 'cancelled', 'rolled_back')),
  payload_enc         bytea,
  payload_key_version integer     CHECK (payload_key_version >= 1),
  mapping             jsonb       CHECK (mapping IS NULL OR jsonb_typeof(mapping) = 'object'),
  rows_total          integer     NOT NULL DEFAULT 0 CHECK (rows_total >= 0),
  rows_valid          integer     NOT NULL DEFAULT 0 CHECK (rows_valid >= 0),
  rows_invalid        integer     NOT NULL DEFAULT 0 CHECK (rows_invalid >= 0),
  invoices_created    integer     NOT NULL DEFAULT 0 CHECK (invoices_created >= 0),
  invoices_updated    integer     NOT NULL DEFAULT 0 CHECK (invoices_updated >= 0),
  invoices_unchanged  integer     NOT NULL DEFAULT 0 CHECK (invoices_unchanged >= 0),
  customers_created   integer     NOT NULL DEFAULT 0 CHECK (customers_created >= 0),
  exceptions_count    integer     NOT NULL DEFAULT 0 CHECK (exceptions_count >= 0),
  -- Aggregates only: {"by_code": {"invalid_date": 3, ...}}; per-row detail is import_row_errors.
  error_report        jsonb       CHECK (error_report IS NULL OR jsonb_typeof(error_report) = 'object'),
  confirmed_at        timestamptz,
  confirmed_by        uuid,
  completed_at        timestamptz,
  rolled_back_at      timestamptz,
  rolled_back_by      uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid,
  updated_by          uuid,
  CONSTRAINT import_runs_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT import_runs_source FOREIGN KEY (tenant_id, source_id) REFERENCES data_sources (tenant_id, id),
  CONSTRAINT import_runs_company FOREIGN KEY (tenant_id, company_id) REFERENCES tenant_companies (tenant_id, id),
  CONSTRAINT import_runs_payload_pair CHECK ((payload_enc IS NULL) = (payload_key_version IS NULL)),
  -- The rows live only while the run can still be validated or processed.
  CONSTRAINT import_runs_payload_lifetime
    CHECK (payload_enc IS NULL OR status IN ('uploaded', 'validated', 'confirmed')),
  CONSTRAINT import_runs_confirmed CHECK ((confirmed_at IS NULL) = (confirmed_by IS NULL)),
  CONSTRAINT import_runs_rolled_back
    CHECK ((status = 'rolled_back') = (rolled_back_at IS NOT NULL AND rolled_back_by IS NOT NULL))
);
CREATE INDEX import_runs_recent ON import_runs (tenant_id, created_at DESC);

-- Mapping template per tenant + source: target field → source column header.
CREATE TABLE import_mappings (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid        NOT NULL REFERENCES tenants (id),
  source_id   uuid        NOT NULL,
  kind        text        NOT NULL DEFAULT 'invoices' CHECK (kind IN ('invoices')),
  mapping     jsonb       NOT NULL CHECK (jsonb_typeof(mapping) = 'object'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  updated_by  uuid,
  CONSTRAINT import_mappings_source FOREIGN KEY (tenant_id, source_id) REFERENCES data_sources (tenant_id, id),
  CONSTRAINT import_mappings_unique UNIQUE (tenant_id, source_id, kind)
);

CREATE TABLE import_row_errors (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid        NOT NULL REFERENCES tenants (id),
  run_id      uuid        NOT NULL,
  row_number  integer     NOT NULL CHECK (row_number >= 1),
  field       text        NOT NULL CHECK (field ~ '^[a-z][a-z_]{0,40}$'),
  error_code  text        NOT NULL CHECK (error_code ~ '^[a-z][a-z_]{0,40}$'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT import_row_errors_run FOREIGN KEY (tenant_id, run_id) REFERENCES import_runs (tenant_id, id)
    ON DELETE CASCADE
);
CREATE INDEX import_row_errors_run ON import_row_errors (tenant_id, run_id, row_number);

-- What an import (or its rollback) could not apply automatically; a person decides.
CREATE TABLE reconciliation_exceptions (
  id            uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid           NOT NULL REFERENCES tenants (id),
  run_id        uuid           NOT NULL,
  invoice_id    uuid,
  row_number    integer        CHECK (row_number >= 1),
  kind          text           NOT NULL CHECK (kind IN ('paid_invoice_changed', 'total_changed',
                                                      'open_amount_increased', 'currency_changed',
                                                      'customer_changed', 'rollback_blocked')),
  currency      char(3)        CHECK (currency ~ '^[A-Z]{3}$'),
  old_amount    numeric(18,2),
  new_amount    numeric(18,2),
  status        text           NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  resolved_at   timestamptz,
  resolved_by   uuid,
  created_at    timestamptz    NOT NULL DEFAULT now(),
  updated_at    timestamptz    NOT NULL DEFAULT now(),
  created_by    uuid,
  updated_by    uuid,
  CONSTRAINT reconciliation_exceptions_run FOREIGN KEY (tenant_id, run_id) REFERENCES import_runs (tenant_id, id),
  CONSTRAINT reconciliation_exceptions_invoice FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices (tenant_id, id),
  CONSTRAINT reconciliation_exceptions_amounts CHECK ((old_amount IS NULL AND new_amount IS NULL) OR currency IS NOT NULL),
  CONSTRAINT reconciliation_exceptions_resolved
    CHECK ((status = 'open') = (resolved_at IS NULL AND resolved_by IS NULL))
);
CREATE INDEX reconciliation_exceptions_open ON reconciliation_exceptions (tenant_id, run_id) WHERE status = 'open';

-- Provenance on the documents an import touches (rollback needs to know what it created).
ALTER TABLE invoices
  ADD COLUMN import_run_id uuid,
  ADD COLUMN last_import_run_id uuid,
  ADD CONSTRAINT invoices_import_run FOREIGN KEY (tenant_id, import_run_id) REFERENCES import_runs (tenant_id, id),
  ADD CONSTRAINT invoices_last_import_run
    FOREIGN KEY (tenant_id, last_import_run_id) REFERENCES import_runs (tenant_id, id);
CREATE INDEX invoices_import_run ON invoices (tenant_id, import_run_id) WHERE import_run_id IS NOT NULL;

ALTER TABLE payments
  ADD COLUMN import_run_id uuid,
  ADD CONSTRAINT payments_import_run FOREIGN KEY (tenant_id, import_run_id) REFERENCES import_runs (tenant_id, id),
  ADD CONSTRAINT payments_settlement_from_import CHECK (kind <> 'source_settlement' OR import_run_id IS NOT NULL);

-- Saved list filters (2.3), private to their user.
CREATE TABLE saved_filters (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid        NOT NULL REFERENCES tenants (id),
  user_id     uuid        NOT NULL,
  entity      text        NOT NULL CHECK (entity IN ('customers')),
  name        text        NOT NULL CHECK (name <> '' AND length(name) <= 80),
  filter      jsonb       NOT NULL CHECK (jsonb_typeof(filter) = 'object'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  updated_by  uuid,
  CONSTRAINT saved_filters_user FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id),
  CONSTRAINT saved_filters_unique UNIQUE (tenant_id, user_id, entity, name)
);

CREATE TRIGGER import_runs_updated_at BEFORE UPDATE ON import_runs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER import_mappings_updated_at BEFORE UPDATE ON import_mappings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER reconciliation_exceptions_updated_at BEFORE UPDATE ON reconciliation_exceptions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER saved_filters_updated_at BEFORE UPDATE ON saved_filters
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE import_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON import_runs
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

ALTER TABLE import_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_mappings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON import_mappings
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

ALTER TABLE import_row_errors ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_row_errors FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON import_row_errors
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

ALTER TABLE reconciliation_exceptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconciliation_exceptions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON reconciliation_exceptions
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

-- Saved filters: tenant isolation here; the service reads and writes only user_id = the caller.
ALTER TABLE saved_filters ENABLE ROW LEVEL SECURITY;
ALTER TABLE saved_filters FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON saved_filters
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

-- Runs are history (status, never deleted); exceptions are resolved, never deleted.
REVOKE DELETE, TRUNCATE ON import_runs, reconciliation_exceptions FROM vigor_app;
REVOKE UPDATE, TRUNCATE ON import_row_errors FROM vigor_app;
REVOKE TRUNCATE ON import_mappings, saved_filters FROM vigor_app;

INSERT INTO pii_field_registry
  (table_name, column_name, pii_class, conditional_on, conditional_pii_class, encrypted, exception_reason, purpose)
VALUES
  ('import_runs', 'payload_enc', 'P1', NULL, NULL, true, NULL,
   'uploaded invoice rows (may name natural persons); dropped when the run ends'),
  ('saved_filters', 'filter', 'P0', 'filter contains free-text search', 'P1', false,
   'search text typed by the user, visible only to that user; deleted with the filter',
   'saved list filter');

INSERT INTO pii_field_registry (table_name, column_name, pii_class, purpose)
SELECT c.table_name, c.column_name, 'P0', 'not personal data (registered by 013)'
FROM information_schema.columns c
WHERE c.table_schema = 'public'
  AND (c.table_name IN ('import_runs', 'import_mappings', 'import_row_errors',
                        'reconciliation_exceptions', 'saved_filters')
       OR (c.table_name, c.column_name) IN (('invoices', 'import_run_id'),
                                            ('invoices', 'last_import_run_id'),
                                            ('payments', 'import_run_id')))
ON CONFLICT (table_name, column_name) DO NOTHING;
