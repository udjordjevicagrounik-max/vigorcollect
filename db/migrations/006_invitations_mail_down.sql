-- 006_invitations_mail_down.sql — reverts 006_invitations_mail_up.sql (dev/test only, rule 15).
-- Deletes every invitation and every captured e-mail.

DELETE FROM pii_field_registry
WHERE table_name IN ('user_invitations', 'mail_outbox')
   OR (table_name, column_name) IN (('tenants', 'is_demo'));

DROP TABLE mail_outbox;
DROP FUNCTION mail_outbox_demo_sink_only();
DROP TABLE user_invitations;
DROP FUNCTION app_invite_token_hash();
DROP FUNCTION user_invitations_guard();

ALTER TABLE tenants DROP CONSTRAINT tenants_platform_not_demo;
ALTER TABLE tenants DROP COLUMN is_demo;
