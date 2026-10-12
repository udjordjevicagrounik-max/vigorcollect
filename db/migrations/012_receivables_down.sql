-- 012_receivables_down.sql — reverts 012_receivables_up.sql (dev/test only, rule 15).
-- Deletes every invoice, payment, allocation, case, promise and activity. Code list rows,
-- translations and the 'file-import' data source seeded by provision_receivables_defaults()
-- are tenant data (FORCE RLS hides them from the owner here) and stay; aging bounds go with
-- their table.

DELETE FROM pii_field_registry
WHERE table_name IN ('aging_bucket_bounds', 'invoices', 'payments', 'payment_allocations',
                     'collection_cases', 'case_invoices', 'promises', 'activities')
   OR (table_name, column_name) IN (('tenant_settings', 'promise_grace_days'),
                                    ('tenant_settings', 'dso_window_days'),
                                    ('tenant_settings', 'allocation_strategy'));

DROP FUNCTION provision_receivables_defaults();
DROP FUNCTION fx_rates_upsert(text, char, char, numeric, date);

DROP TABLE activities;
DROP TABLE promises;
DROP TABLE case_invoices;
DROP TABLE collection_cases;
DROP TABLE payment_allocations;
DROP TABLE payments;
DROP TABLE invoices;
DROP TABLE aging_bucket_bounds;

DROP FUNCTION payment_allocations_touch_invoice();
DROP FUNCTION payment_allocations_check();
DROP FUNCTION payments_delete_guard();
DROP FUNCTION payments_fx_frozen();
DROP FUNCTION invoices_derive();

ALTER TABLE tenant_settings
  DROP COLUMN allocation_strategy,
  DROP COLUMN dso_window_days,
  DROP COLUMN promise_grace_days;
