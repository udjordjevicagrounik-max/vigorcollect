-- 019_mail_inbox_down.sql — reverts 019_mail_inbox_up.sql (dev/test only, rule 15). Deletes all
-- received mail. Outbox rows written with the new kinds/transport/status cannot be deleted under
-- FORCE RLS, so the old CHECKs come back NOT VALID (rows expire through retention).

DELETE FROM pii_field_registry
WHERE table_name = 'mail_inbox'
   OR (table_name, column_name) IN (('mail_outbox', 'message_id'), ('mail_outbox', 'integration_id'),
                                    ('mail_outbox', 'case_id'), ('mail_outbox', 'in_reply_to_id'),
                                    ('mail_outbox', 'attempts'), ('mail_outbox', 'next_attempt_at'),
                                    ('mail_outbox', 'status_reason'), ('mail_outbox', 'bounced_at'));

DROP TABLE IF EXISTS mail_inbox;
DROP FUNCTION IF EXISTS mail_outbox_delivery(uuid, text, text, text, timestamptz);

DROP INDEX IF EXISTS mail_outbox_due;
DROP INDEX IF EXISTS mail_outbox_message_id;
ALTER TABLE mail_outbox
  DROP CONSTRAINT IF EXISTS mail_outbox_bounced,
  DROP CONSTRAINT IF EXISTS mail_outbox_integration_transport,
  DROP CONSTRAINT IF EXISTS mail_outbox_case,
  DROP CONSTRAINT IF EXISTS mail_outbox_integration,
  DROP COLUMN IF EXISTS bounced_at,
  DROP COLUMN IF EXISTS status_reason,
  DROP COLUMN IF EXISTS next_attempt_at,
  DROP COLUMN IF EXISTS attempts,
  DROP COLUMN IF EXISTS in_reply_to_id,
  DROP COLUMN IF EXISTS message_id,
  DROP COLUMN IF EXISTS case_id,
  DROP COLUMN IF EXISTS integration_id;

ALTER TABLE mail_outbox DROP CONSTRAINT mail_outbox_sent_at;
ALTER TABLE mail_outbox ADD CONSTRAINT mail_outbox_sent_at
  CHECK ((status = 'sent') = (sent_at IS NOT NULL)) NOT VALID;
ALTER TABLE mail_outbox DROP CONSTRAINT mail_outbox_status_check;
ALTER TABLE mail_outbox ADD CONSTRAINT mail_outbox_status_check
  CHECK (status IN ('captured', 'pending', 'sent', 'failed')) NOT VALID;
ALTER TABLE mail_outbox DROP CONSTRAINT mail_outbox_transport_check;
ALTER TABLE mail_outbox ADD CONSTRAINT mail_outbox_transport_check
  CHECK (transport IN ('sink', 'smtp')) NOT VALID;
ALTER TABLE mail_outbox DROP CONSTRAINT mail_outbox_kind_check;
ALTER TABLE mail_outbox ADD CONSTRAINT mail_outbox_kind_check
  CHECK (kind IN ('invitation', 'password_reset', 'reminder', 'dunning', 'statement', 'document')) NOT VALID;
