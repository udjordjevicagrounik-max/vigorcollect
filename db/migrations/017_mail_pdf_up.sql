-- 017_mail_pdf_up.sql — Sprint 3 close-out (3.3). Protected file (rule 13).
--
-- 1. mail_outbox.kind widened for collection mail (reminder, dunning, statement, document).
--    The only non-additive step: the CHECK is replaced (DROP + ADD of the same constraint name),
--    no data changes, the new set is a superset of the old one — allowed under rule 15 by
--    Uroš's decision of 2026-10-13 (ADR 0003, "Zamena CHECK-a").
-- 2. mail_outbox knows where collection mail came from (customer, template, rule run) — ids only.
-- 3. document_renditions: the PDF of a generated (HTML) document, rendered in the worker from
--    the same HTML (task 3.3). Content lives in the storage adapter, encrypted; download only
--    through exportService (rule 12).

-- ============================================================================================
-- mail_outbox
-- ============================================================================================

ALTER TABLE mail_outbox DROP CONSTRAINT mail_outbox_kind_check;
ALTER TABLE mail_outbox ADD CONSTRAINT mail_outbox_kind_check
  CHECK (kind IN ('invitation', 'password_reset', 'reminder', 'dunning', 'statement', 'document'));

ALTER TABLE mail_outbox
  ADD COLUMN customer_id   uuid,
  ADD COLUMN template_id   uuid,
  ADD COLUMN source_run_id uuid,
  ADD CONSTRAINT mail_outbox_customer FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
  ADD CONSTRAINT mail_outbox_template FOREIGN KEY (tenant_id, template_id) REFERENCES templates (tenant_id, id),
  ADD CONSTRAINT mail_outbox_run FOREIGN KEY (tenant_id, source_run_id) REFERENCES workflow_runs (tenant_id, id),
  -- Collection mail is always about a customer and rendered from a template; auth mail never is.
  ADD CONSTRAINT mail_outbox_collection_refs
    CHECK ((kind IN ('invitation', 'password_reset')) = (customer_id IS NULL AND template_id IS NULL));
CREATE INDEX mail_outbox_customer ON mail_outbox (tenant_id, customer_id, created_at DESC)
  WHERE customer_id IS NOT NULL;

-- ============================================================================================
-- document_renditions — the PDF of a document (same template, same HTML)
-- ============================================================================================

CREATE TABLE document_renditions (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid        NOT NULL REFERENCES tenants (id),
  document_id  uuid        NOT NULL,
  format       text        NOT NULL CHECK (format IN ('pdf')),
  checksum     bytea       NOT NULL CHECK (length(checksum) = 32),
  size_bytes   integer     NOT NULL CHECK (size_bytes > 0),
  storage_ref  text        NOT NULL CHECK (storage_ref ~ '^[a-z]+:[A-Za-z0-9/_.-]{1,250}$'),
  key_version  integer     NOT NULL CHECK (key_version >= 1),
  -- Renderer and version that produced it (e.g. "chromium/155.0.8059.39") — reproducibility.
  renderer     text        NOT NULL CHECK (renderer ~ '^[a-z]+/[0-9A-Za-z._-]{1,40}$'),
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid,
  CONSTRAINT document_renditions_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT document_renditions_document FOREIGN KEY (tenant_id, document_id) REFERENCES documents (tenant_id, id),
  -- One PDF per document version; a re-render job that finds it does nothing (idempotent).
  CONSTRAINT document_renditions_once UNIQUE (tenant_id, document_id, format)
);

ALTER TABLE document_renditions ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_renditions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON document_renditions
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

-- Renditions are history, like documents.
REVOKE UPDATE, DELETE, TRUNCATE ON document_renditions FROM vigor_app;

-- Rule proposals waiting for a person to submit them (attention list, task 3.3).
CREATE INDEX decisions_rule_proposals ON decisions (tenant_id, created_at)
  WHERE source = 'rule' AND status = 'proposed' AND approval_request_id IS NULL;

-- ============================================================================================
-- PII registry (rule 20)
-- ============================================================================================

INSERT INTO pii_field_registry (table_name, column_name, pii_class, purpose)
SELECT c.table_name, c.column_name, 'P0', 'not personal data (registered by 017)'
FROM information_schema.columns c
WHERE c.table_schema = 'public'
  AND (c.table_name = 'document_renditions'
       OR (c.table_name, c.column_name) IN (('mail_outbox', 'customer_id'), ('mail_outbox', 'template_id'),
                                            ('mail_outbox', 'source_run_id')))
ON CONFLICT (table_name, column_name) DO NOTHING;
