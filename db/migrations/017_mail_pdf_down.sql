-- 017_mail_pdf_down.sql — reverts 017_mail_pdf_up.sql (dev/test only, rule 15). Deletes every
-- PDF rendition row (the files stay in the storage). Collection mail rows already in
-- mail_outbox cannot be deleted here (FORCE RLS), so the old kind CHECK comes back NOT VALID:
-- new rows are checked, existing ones expire through retention (7 days).

DELETE FROM pii_field_registry
WHERE table_name = 'document_renditions'
   OR (table_name, column_name) IN (('mail_outbox', 'customer_id'), ('mail_outbox', 'template_id'),
                                    ('mail_outbox', 'source_run_id'));

DROP INDEX IF EXISTS decisions_rule_proposals;
DROP TABLE IF EXISTS document_renditions;

DROP INDEX IF EXISTS mail_outbox_customer;
ALTER TABLE mail_outbox
  DROP CONSTRAINT IF EXISTS mail_outbox_collection_refs,
  DROP CONSTRAINT IF EXISTS mail_outbox_run,
  DROP CONSTRAINT IF EXISTS mail_outbox_template,
  DROP CONSTRAINT IF EXISTS mail_outbox_customer,
  DROP COLUMN IF EXISTS source_run_id,
  DROP COLUMN IF EXISTS template_id,
  DROP COLUMN IF EXISTS customer_id;

ALTER TABLE mail_outbox DROP CONSTRAINT mail_outbox_kind_check;
ALTER TABLE mail_outbox ADD CONSTRAINT mail_outbox_kind_check
  CHECK (kind IN ('invitation', 'password_reset')) NOT VALID;
