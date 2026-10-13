-- 024_disputes_bulk_down.sql — reverts 024_disputes_bulk_up.sql (dev/test only, rule 15).
-- Deletes all disputes and bulk runs.
DELETE FROM pii_field_registry
WHERE table_name IN ('disputes', 'dispute_invoices', 'dispute_documents', 'bulk_runs', 'bulk_run_items')
   OR (table_name, column_name) IN (('customers', 'payment_behaviour_list_key'),
                                    ('customers', 'payment_behaviour_code'),
                                    ('tenant_settings', 'bulk_max_items'));
DROP INDEX IF EXISTS invoices_number_search;
DROP INDEX IF EXISTS customers_external_id_search;
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
  -- The column stays (a view cannot lose a column without dropping dependants such as
  -- attention_customer_items); it no longer refers to the dispute tables.
  false AS is_disputed
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
DROP TABLE IF EXISTS bulk_run_items;
DROP TABLE IF EXISTS bulk_runs;
ALTER TABLE tenant_settings DROP COLUMN IF EXISTS bulk_max_items;
DROP TABLE IF EXISTS dispute_documents;
DROP TABLE IF EXISTS dispute_invoices;
DROP TABLE IF EXISTS disputes;
DROP FUNCTION IF EXISTS disputes_guard();
ALTER TABLE customers
  DROP CONSTRAINT IF EXISTS customers_payment_behaviour,
  DROP COLUMN IF EXISTS payment_behaviour_code,
  DROP COLUMN IF EXISTS payment_behaviour_list_key;
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
END $$;
DROP FUNCTION IF EXISTS provision_sprint5_defaults();
