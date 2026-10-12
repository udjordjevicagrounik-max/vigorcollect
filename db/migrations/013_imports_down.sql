-- 013_imports_down.sql — reverts 013_imports_up.sql (dev/test only, rule 15).

DELETE FROM pii_field_registry
WHERE table_name IN ('import_runs', 'import_mappings', 'import_row_errors',
                     'reconciliation_exceptions', 'saved_filters')
   OR (table_name, column_name) IN (('invoices', 'import_run_id'),
                                    ('invoices', 'last_import_run_id'),
                                    ('payments', 'import_run_id'));

DROP TABLE saved_filters;

ALTER TABLE payments
  DROP CONSTRAINT payments_settlement_from_import,
  DROP CONSTRAINT payments_import_run,
  DROP COLUMN import_run_id;

DROP INDEX invoices_import_run;
ALTER TABLE invoices
  DROP CONSTRAINT invoices_last_import_run,
  DROP CONSTRAINT invoices_import_run,
  DROP COLUMN last_import_run_id,
  DROP COLUMN import_run_id;

DROP TABLE reconciliation_exceptions;
DROP TABLE import_row_errors;
DROP TABLE import_mappings;
DROP TABLE import_runs;
