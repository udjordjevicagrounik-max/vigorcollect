-- 024_disputes_bulk_up.sql — Sprint 5.1: disputes, payment behaviour, bulk runs.
-- Additive (rule 15); provision_receivables_defaults() is replaced with the same body plus one
-- PERFORM; invoice_positions gets one column at the end (CREATE OR REPLACE VIEW). Protected (rule 13).
--
-- disputes: a customer contests one or more invoices (reason from code list dispute_reason). A
-- disputed invoice stays in aging but is marked (invoice_positions.is_disputed); the rule engine
-- sends no reminder for it (condition has_open_dispute + engine skip). customers.payment_behaviour
-- (unwilling / unable / disputed) is set by the collector (code list payment_behaviour).
-- bulk_runs / bulk_run_items: a bulk action on a customer or invoice list is ONE run processed by
-- the worker, one result per item (rule 6: audit per item + one for the run).

-- ============================================================================================
-- Code lists (new tenants through provision_receivables_defaults, existing ones below)
-- ============================================================================================
CREATE FUNCTION provision_sprint5_defaults() RETURNS void
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
DECLARE
  t uuid := app_tenant_id();
BEGIN
  IF t IS NULL THEN
    RAISE EXCEPTION 'provision_sprint5_defaults requires a tenant context'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO code_lists (tenant_id, list_key, code, is_system, sort_order)
  SELECT t, v.list_key, v.code, true, v.sort_order
  FROM (VALUES
    ('dispute_reason', 'incorrect_invoice', 0), ('dispute_reason', 'missing_docs', 1),
    ('dispute_reason', 'pricing', 2), ('dispute_reason', 'quality', 3),
    ('dispute_reason', 'delivery', 4), ('dispute_reason', 'already_paid', 5),
    ('dispute_reason', 'contract', 6), ('dispute_reason', 'other', 7),
    ('payment_behaviour', 'unwilling', 0), ('payment_behaviour', 'unable', 1),
    ('payment_behaviour', 'disputed', 2)
  ) AS v(list_key, code, sort_order)
  ON CONFLICT (tenant_id, list_key, code) DO NOTHING;
  INSERT INTO translations (tenant_id, entity_type, entity_key, locale, text)
  SELECT t, 'code_list', v.k, v.loc, v.txt
  FROM (VALUES
    ('dispute_reason.incorrect_invoice', 'sr-Latn', 'Neispravna faktura'), ('dispute_reason.incorrect_invoice', 'en', 'Incorrect invoice'),
    ('dispute_reason.missing_docs', 'sr-Latn', 'Nedostaje dokumentacija'), ('dispute_reason.missing_docs', 'en', 'Missing documents'),
    ('dispute_reason.pricing', 'sr-Latn', 'Cena'), ('dispute_reason.pricing', 'en', 'Pricing'),
    ('dispute_reason.quality', 'sr-Latn', 'Kvalitet'), ('dispute_reason.quality', 'en', 'Quality'),
    ('dispute_reason.delivery', 'sr-Latn', 'Isporuka'), ('dispute_reason.delivery', 'en', 'Delivery'),
    ('dispute_reason.already_paid', 'sr-Latn', 'Već plaćeno'), ('dispute_reason.already_paid', 'en', 'Already paid'),
    ('dispute_reason.contract', 'sr-Latn', 'Ugovor'), ('dispute_reason.contract', 'en', 'Contract'),
    ('dispute_reason.other', 'sr-Latn', 'Ostalo'), ('dispute_reason.other', 'en', 'Other'),
    ('payment_behaviour.unwilling', 'sr-Latn', 'Neće da plati'), ('payment_behaviour.unwilling', 'en', 'Unwilling to pay'),
    ('payment_behaviour.unable', 'sr-Latn', 'Ne može da plati'), ('payment_behaviour.unable', 'en', 'Unable to pay'),
    ('payment_behaviour.disputed', 'sr-Latn', 'Osporava'), ('payment_behaviour.disputed', 'en', 'Disputes the claim')
  ) AS v(k, loc, txt)
  ON CONFLICT (tenant_id, entity_type, entity_key, field, locale) DO NOTHING;
END $$;

CREATE OR REPLACE FUNCTION provision_receivables_defaults() RETURNS void
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
DECLARE
  t uuid := app_tenant_id();
BEGIN
  IF t IS NULL THEN
    RAISE EXCEPTION 'provision_receivables_defaults requires a tenant context'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO code_lists (tenant_id, list_key, code, is_system, sort_order)
  SELECT t, v.list_key, v.code, true, v.sort_order
  FROM (VALUES
    ('aging_bucket', 'current', 0), ('aging_bucket', 'd1_30', 1), ('aging_bucket', 'd31_60', 2),
    ('aging_bucket', 'd61_90', 3), ('aging_bucket', 'd91_180', 4), ('aging_bucket', 'd181_plus', 5),
    ('case_stage', 'new', 0), ('case_stage', 'contact', 1), ('case_stage', 'promise', 2),
    ('case_stage', 'dispute', 3), ('case_stage', 'legal', 4), ('case_stage', 'resolved', 5),
    ('activity_outcome', 'reached', 0), ('activity_outcome', 'no_answer', 1),
    ('activity_outcome', 'promise_given', 2), ('activity_outcome', 'dispute_raised', 3),
    ('activity_outcome', 'wrong_contact', 4), ('activity_outcome', 'callback', 5),
    ('next_action', 'call', 0), ('next_action', 'email', 1), ('next_action', 'meeting', 2),
    ('next_action', 'check_payment', 3),
    -- 015: why a source lowered an open amount without a payment
    ('adjustment_reason', 'unknown', 0), ('adjustment_reason', 'credit_note', 1),
    ('adjustment_reason', 'write_off', 2), ('adjustment_reason', 'source_correction', 3)
  ) AS v(list_key, code, sort_order)
  ON CONFLICT (tenant_id, list_key, code) DO NOTHING;

  -- The tenant's own ERP export, uploaded as a file (import wizard, 2.2). Own data: may be
  -- displayed, stored and derived from; never redistributed.
  INSERT INTO data_sources (tenant_id, name, source_type, may_display, may_store, may_derive)
  VALUES (t, 'file-import', 'ERP_FILE', true, true, true)
  ON CONFLICT (tenant_id, name) DO NOTHING;

  INSERT INTO aging_bucket_bounds (tenant_id, code, min_days_overdue, max_days_overdue)
  VALUES (t, 'current', 0, 0), (t, 'd1_30', 1, 30), (t, 'd31_60', 31, 60), (t, 'd61_90', 61, 90),
         (t, 'd91_180', 91, 180), (t, 'd181_plus', 181, NULL)
  ON CONFLICT (tenant_id, code) DO NOTHING;

  INSERT INTO translations (tenant_id, entity_type, entity_key, locale, text)
  SELECT t, 'code_list', v.k, v.loc, v.txt
  FROM (VALUES
    ('aging_bucket.current', 'sr-Latn', 'Nije dospelo'), ('aging_bucket.current', 'en', 'Not due'),
    ('aging_bucket.d1_30', 'sr-Latn', '1–30 dana'), ('aging_bucket.d1_30', 'en', '1–30 days'),
    ('aging_bucket.d31_60', 'sr-Latn', '31–60 dana'), ('aging_bucket.d31_60', 'en', '31–60 days'),
    ('aging_bucket.d61_90', 'sr-Latn', '61–90 dana'), ('aging_bucket.d61_90', 'en', '61–90 days'),
    ('aging_bucket.d91_180', 'sr-Latn', '91–180 dana'), ('aging_bucket.d91_180', 'en', '91–180 days'),
    ('aging_bucket.d181_plus', 'sr-Latn', 'Preko 180 dana'), ('aging_bucket.d181_plus', 'en', 'Over 180 days'),
    ('case_stage.new', 'sr-Latn', 'Novi'), ('case_stage.new', 'en', 'New'),
    ('case_stage.contact', 'sr-Latn', 'Kontakt'), ('case_stage.contact', 'en', 'Contact'),
    ('case_stage.promise', 'sr-Latn', 'Obećanje'), ('case_stage.promise', 'en', 'Promise'),
    ('case_stage.dispute', 'sr-Latn', 'Spor'), ('case_stage.dispute', 'en', 'Dispute'),
    ('case_stage.legal', 'sr-Latn', 'Pravna služba'), ('case_stage.legal', 'en', 'Legal'),
    ('case_stage.resolved', 'sr-Latn', 'Rešeno'), ('case_stage.resolved', 'en', 'Resolved'),
    ('activity_outcome.reached', 'sr-Latn', 'Dobijen kontakt'), ('activity_outcome.reached', 'en', 'Reached'),
    ('activity_outcome.no_answer', 'sr-Latn', 'Bez odgovora'), ('activity_outcome.no_answer', 'en', 'No answer'),
    ('activity_outcome.promise_given', 'sr-Latn', 'Dato obećanje'), ('activity_outcome.promise_given', 'en', 'Promise given'),
    ('activity_outcome.dispute_raised', 'sr-Latn', 'Prijavljen spor'), ('activity_outcome.dispute_raised', 'en', 'Dispute raised'),
    ('activity_outcome.wrong_contact', 'sr-Latn', 'Pogrešan kontakt'), ('activity_outcome.wrong_contact', 'en', 'Wrong contact'),
    ('activity_outcome.callback', 'sr-Latn', 'Zvati ponovo'), ('activity_outcome.callback', 'en', 'Call back'),
    ('next_action.call', 'sr-Latn', 'Poziv'), ('next_action.call', 'en', 'Call'),
    ('next_action.email', 'sr-Latn', 'Email'), ('next_action.email', 'en', 'Email'),
    ('next_action.meeting', 'sr-Latn', 'Sastanak'), ('next_action.meeting', 'en', 'Meeting'),
    ('next_action.check_payment', 'sr-Latn', 'Proveri uplatu'), ('next_action.check_payment', 'en', 'Check payment'),
    ('adjustment_reason.unknown', 'sr-Latn', 'Nepoznat razlog'), ('adjustment_reason.unknown', 'en', 'Unknown reason'),
    ('adjustment_reason.credit_note', 'sr-Latn', 'Knjižno odobrenje'), ('adjustment_reason.credit_note', 'en', 'Credit note'),
    ('adjustment_reason.write_off', 'sr-Latn', 'Otpis'), ('adjustment_reason.write_off', 'en', 'Write-off'),
    ('adjustment_reason.source_correction', 'sr-Latn', 'Ispravka u izvoru'), ('adjustment_reason.source_correction', 'en', 'Source correction')
  ) AS v(k, loc, txt)
  ON CONFLICT (tenant_id, entity_type, entity_key, field, locale) DO NOTHING;

  -- 016: collection policies and the Standard workflows.
  PERFORM provision_collection_defaults();
  -- 024 (Sprint 5.1): dispute reasons and payment behaviour.
  PERFORM provision_sprint5_defaults();
END $$;

-- Existing tenants: the owner reads tenants only through the tenant_clock GUC (007), one tenant
-- context per provisioning call.
DO $$
DECLARE
  tid uuid;
BEGIN
  PERFORM set_config('app.tenant_clock', 'on', true);
  FOR tid IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', tid::text, true);
    IF EXISTS (SELECT 1 FROM code_lists WHERE list_key = 'aging_bucket') THEN
      PERFORM provision_sprint5_defaults();
    END IF;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
  PERFORM set_config('app.tenant_clock', '', true);
END $$;

-- ============================================================================================
-- customers.payment_behaviour
-- ============================================================================================
ALTER TABLE customers
  ADD COLUMN payment_behaviour_list_key text GENERATED ALWAYS AS ('payment_behaviour') STORED,
  ADD COLUMN payment_behaviour_code text,
  ADD CONSTRAINT customers_payment_behaviour
    FOREIGN KEY (tenant_id, payment_behaviour_list_key, payment_behaviour_code)
    REFERENCES code_lists (tenant_id, list_key, code);

-- ============================================================================================
-- disputes
-- ============================================================================================
CREATE TABLE disputes (
  id                          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   uuid        NOT NULL REFERENCES tenants (id),
  customer_id                 uuid        NOT NULL,
  reason_list_key             text        GENERATED ALWAYS AS ('dispute_reason') STORED,
  reason_code                 text        NOT NULL,
  owner_user_id               uuid,
  status                      text        NOT NULL DEFAULT 'open'
                                          CHECK (status IN ('open', 'in_review', 'resolved_accepted',
                                                            'resolved_rejected', 'withdrawn')),
  opened_at                   timestamptz NOT NULL DEFAULT now(),
  -- Business date (rule 26): when an answer is expected.
  expected_by                 date,
  resolved_at                 timestamptz,
  -- Free text of the member who closes it: encrypted per customer (ADR 0003), like activities.
  resolution_note_enc         bytea,
  resolution_note_key_version integer     CHECK (resolution_note_key_version >= 1),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  created_by                  uuid,
  updated_by                  uuid,
  CONSTRAINT disputes_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT disputes_customer FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
  CONSTRAINT disputes_owner FOREIGN KEY (tenant_id, owner_user_id) REFERENCES users (tenant_id, id),
  CONSTRAINT disputes_reason FOREIGN KEY (tenant_id, reason_list_key, reason_code)
    REFERENCES code_lists (tenant_id, list_key, code),
  CONSTRAINT disputes_resolved
    CHECK ((status IN ('resolved_accepted', 'resolved_rejected', 'withdrawn')) = (resolved_at IS NOT NULL)),
  CONSTRAINT disputes_note_pair CHECK ((resolution_note_enc IS NULL) = (resolution_note_key_version IS NULL))
);
CREATE INDEX disputes_customer ON disputes (tenant_id, customer_id, status);
CREATE INDEX disputes_open ON disputes (tenant_id, opened_at) WHERE status IN ('open', 'in_review');

CREATE TABLE dispute_invoices (
  tenant_id   uuid        NOT NULL REFERENCES tenants (id),
  dispute_id  uuid        NOT NULL,
  invoice_id  uuid        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, dispute_id, invoice_id),
  CONSTRAINT dispute_invoices_dispute FOREIGN KEY (tenant_id, dispute_id) REFERENCES disputes (tenant_id, id),
  CONSTRAINT dispute_invoices_invoice FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices (tenant_id, id)
);
CREATE INDEX dispute_invoices_invoice ON dispute_invoices (tenant_id, invoice_id);

CREATE TABLE dispute_documents (
  tenant_id    uuid        NOT NULL REFERENCES tenants (id),
  dispute_id   uuid        NOT NULL,
  document_id  uuid        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, dispute_id, document_id),
  CONSTRAINT dispute_documents_dispute FOREIGN KEY (tenant_id, dispute_id) REFERENCES disputes (tenant_id, id),
  CONSTRAINT dispute_documents_document FOREIGN KEY (tenant_id, document_id) REFERENCES documents (tenant_id, id)
);

-- Status machine for every role: open → in_review → resolved_* | withdrawn; open → resolved_* |
-- withdrawn. A closed dispute is final; customer and opening never change.
CREATE FUNCTION disputes_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.customer_id <> OLD.customer_id OR NEW.opened_at <> OLD.opened_at THEN
    RAISE EXCEPTION 'disputes: customer and opening are frozen' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'open' AND NEW.status IN ('in_review', 'resolved_accepted', 'resolved_rejected', 'withdrawn'))
    OR (OLD.status = 'in_review' AND NEW.status IN ('resolved_accepted', 'resolved_rejected', 'withdrawn'))
  ) THEN
    RAISE EXCEPTION 'disputes: % → % is not allowed', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status IN ('resolved_accepted', 'resolved_rejected', 'withdrawn') THEN
    RAISE EXCEPTION 'disputes: a closed dispute is final' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER disputes_guard BEFORE UPDATE ON disputes
  FOR EACH ROW EXECUTE FUNCTION disputes_guard();
CREATE TRIGGER disputes_updated_at BEFORE UPDATE ON disputes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE VIEW invoice_positions WITH (security_invoker = true) AS
SELECT
  i.id AS invoice_id,
  i.tenant_id,
  i.customer_id,
  i.company_id,
  i.number,
  i.issue_date,
  i.due_date,
  i.currency,
  i.amount_total,
  i.amount_open,
  i.accounting_status,
  d.local_today,
  (i.amount_open > 0 AND i.accounting_status NOT IN ('credited', 'cancelled')) AS is_open,
  (i.amount_open > 0 AND i.accounting_status NOT IN ('credited', 'cancelled')
   AND i.due_date < d.local_today) AS is_overdue,
  GREATEST(d.local_today - i.due_date, 0) AS days_overdue,
  b.code AS aging_bucket,
  ts.default_currency AS reporting_currency,
  fx_convert(i.amount_open, i.currency, ts.default_currency, d.local_today) AS open_reporting,
  fx_convert(i.amount_total, i.currency, ts.default_currency, i.issue_date) AS total_reporting,
  -- 015: amounts settled by adjustments (not money) — added back for DSO (docs/metrics.md).
  adj.adjusted,
  fx_convert(CASE WHEN i.accounting_status IN ('credited', 'cancelled') THEN 0
                  ELSE i.amount_open + adj.adjusted END,
             i.currency, ts.default_currency, d.local_today) AS dso_open_reporting,
  -- 024: the invoice is part of an open dispute — it stays in aging, marked.
  EXISTS (SELECT 1 FROM dispute_invoices di JOIN disputes ds ON ds.tenant_id = di.tenant_id AND ds.id = di.dispute_id
          WHERE di.tenant_id = i.tenant_id AND di.invoice_id = i.id AND ds.status IN ('open', 'in_review')) AS is_disputed
FROM invoices i
JOIN tenant_companies tc ON tc.tenant_id = i.tenant_id AND tc.id = i.company_id
JOIN legal_entities le ON le.id = tc.legal_entity_id
JOIN tenant_settings ts ON ts.tenant_id = i.tenant_id
CROSS JOIN LATERAL (SELECT (now() AT TIME ZONE le.timezone)::date AS local_today) d
CROSS JOIN LATERAL (
  SELECT coalesce(sum(a.amount), 0)::numeric(18,2) AS adjusted
  FROM payment_allocations a JOIN payments p ON p.tenant_id = a.tenant_id AND p.id = a.payment_id
  WHERE a.tenant_id = i.tenant_id AND a.invoice_id = i.id AND p.payment_kind = 'adjustment'
) adj
LEFT JOIN aging_bucket_bounds b
  ON b.tenant_id = i.tenant_id
 AND GREATEST(d.local_today - i.due_date, 0) >= b.min_days_overdue
 AND (b.max_days_overdue IS NULL OR GREATEST(d.local_today - i.due_date, 0) <= b.max_days_overdue);

-- ============================================================================================
-- bulk runs
-- ============================================================================================
ALTER TABLE tenant_settings
  ADD COLUMN bulk_max_items integer NOT NULL DEFAULT 500 CHECK (bulk_max_items BETWEEN 1 AND 5000);

CREATE TABLE bulk_runs (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid        NOT NULL REFERENCES tenants (id),
  entity_type    text        NOT NULL CHECK (entity_type IN ('customers', 'invoices')),
  action         text        NOT NULL CHECK (action IN ('assign_owner', 'assign_team', 'change_policy',
                                                       'send_reminder', 'open_case', 'export')),
  -- ids and codes only (P0): owner id, team id, policy code, template key, export format.
  params         jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(params) = 'object'),
  status         text        NOT NULL DEFAULT 'queued'
                             CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  item_count     integer     NOT NULL CHECK (item_count BETWEEN 1 AND 5000),
  ok_count       integer     NOT NULL DEFAULT 0 CHECK (ok_count >= 0),
  failed_count   integer     NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  requested_by   uuid        NOT NULL,
  request_id     uuid,
  -- Export runs: the produced file (encrypted, documents storage) for exportService.
  result_ref     text        CHECK (result_ref ~ '^[a-z]+:[A-Za-z0-9/_.-]{1,250}$'),
  created_at     timestamptz NOT NULL DEFAULT now(),
  started_at     timestamptz,
  finished_at    timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bulk_runs_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT bulk_runs_requested_by FOREIGN KEY (tenant_id, requested_by) REFERENCES users (tenant_id, id),
  CONSTRAINT bulk_runs_finished CHECK ((status IN ('completed', 'failed')) = (finished_at IS NOT NULL))
);
CREATE TABLE bulk_run_items (
  tenant_id     uuid        NOT NULL REFERENCES tenants (id),
  run_id        uuid        NOT NULL,
  entity_id     uuid        NOT NULL,
  status        text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ok', 'failed', 'skipped')),
  error_code    text        CHECK (error_code ~ '^[a-z][a-z0-9_.]{1,62}$'),
  processed_at  timestamptz,
  PRIMARY KEY (tenant_id, run_id, entity_id),
  CONSTRAINT bulk_run_items_run FOREIGN KEY (tenant_id, run_id) REFERENCES bulk_runs (tenant_id, id)
);
CREATE TRIGGER bulk_runs_updated_at BEFORE UPDATE ON bulk_runs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Search (5.1): invoice number and customer external id, per tenant.
CREATE INDEX invoices_number_search ON invoices (tenant_id, lower(number));
CREATE INDEX customers_external_id_search ON customers (tenant_id, lower(external_id));

-- ============================================================================================
-- RLS, grants, PII registry
-- ============================================================================================
ALTER TABLE disputes ENABLE ROW LEVEL SECURITY;
ALTER TABLE disputes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON disputes
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE dispute_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE dispute_invoices FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON dispute_invoices
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE dispute_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE dispute_documents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON dispute_documents
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE bulk_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE bulk_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON bulk_runs
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE bulk_run_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE bulk_run_items FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON bulk_run_items
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

-- History: disputes, their invoice links and bulk runs are never deleted.
REVOKE DELETE, TRUNCATE ON disputes, dispute_invoices, bulk_runs, bulk_run_items FROM vigor_app;
REVOKE TRUNCATE ON dispute_documents FROM vigor_app;

INSERT INTO pii_field_registry (table_name, column_name, pii_class, encrypted, purpose)
VALUES ('disputes', 'resolution_note_enc', 'P1', true, 'how a dispute was resolved (member free text)');
INSERT INTO pii_field_registry (table_name, column_name, pii_class, purpose)
SELECT c.table_name, c.column_name, 'P0', 'not personal data (registered by 024)'
FROM information_schema.columns c
WHERE c.table_schema = 'public'
  AND c.table_name IN ('disputes', 'dispute_invoices', 'dispute_documents', 'bulk_runs', 'bulk_run_items')
  AND NOT (c.table_name = 'disputes' AND c.column_name = 'resolution_note_enc');
INSERT INTO pii_field_registry (table_name, column_name, pii_class, purpose)
VALUES ('customers', 'payment_behaviour_list_key', 'P0', 'not personal data (registered by 024)'),
       ('customers', 'payment_behaviour_code', 'P0', 'collector assessment: unwilling / unable / disputed'),
       ('tenant_settings', 'bulk_max_items', 'P0', 'not personal data (registered by 024)');
