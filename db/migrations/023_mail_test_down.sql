-- 023_mail_test_down.sql — reverts 023_mail_test_up.sql (dev/test only, rule 15). Deletes test
-- messages (they concern no customer and carry no business data).
DELETE FROM mail_outbox WHERE kind = 'test';
ALTER TABLE mail_outbox DROP CONSTRAINT mail_outbox_collection_refs;
ALTER TABLE mail_outbox ADD CONSTRAINT mail_outbox_collection_refs
  CHECK ((kind IN ('invitation', 'password_reset')) = (customer_id IS NULL AND template_id IS NULL));
ALTER TABLE mail_outbox DROP CONSTRAINT mail_outbox_kind_check;
ALTER TABLE mail_outbox ADD CONSTRAINT mail_outbox_kind_check
  CHECK (kind IN ('invitation', 'password_reset', 'reminder', 'dunning', 'statement', 'document',
                  'reply'));
