-- 025_reports_exports_digest_down.sql — reverts 025 (dev/test only, rule 15). Deletes digest mails
-- (they concern no customer) and the export files' rows (the sealed files expire on disk).
DELETE FROM pii_field_registry
WHERE table_name IN ('export_files', 'saved_reports', 'notification_preferences', 'digest_runs',
                     'company_holidays')
   OR (table_name = 'tenant_companies' AND column_name = 'working_days');
DROP FUNCTION is_working_day(uuid, date);
DROP TABLE company_holidays;
ALTER TABLE tenant_companies DROP COLUMN working_days;
DELETE FROM mail_outbox WHERE kind = 'digest';
ALTER TABLE mail_outbox DROP CONSTRAINT mail_outbox_collection_refs;
ALTER TABLE mail_outbox ADD CONSTRAINT mail_outbox_collection_refs
  CHECK ((kind IN ('invitation', 'password_reset', 'test')) = (customer_id IS NULL AND template_id IS NULL));
ALTER TABLE mail_outbox DROP CONSTRAINT mail_outbox_kind_check;
ALTER TABLE mail_outbox ADD CONSTRAINT mail_outbox_kind_check
  CHECK (kind IN ('invitation', 'password_reset', 'reminder', 'dunning', 'statement', 'document',
                  'reply', 'test'));
DROP TABLE digest_runs;
DROP TABLE notification_preferences;
DROP TABLE saved_reports;
DROP TABLE export_files;
