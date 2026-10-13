-- 023_mail_test_up.sql — session 5.1: "Send a test message" (Admin → Integrations).
-- Protected (rule 13). The only non-additive steps: two CHECKs are replaced by supersets under the
-- same names (ADR 0003, "Zamena CHECK-a"), no data changes.
--
-- mail_outbox.kind 'test': a fixed message from the product to the SIGNED-IN member's own address,
-- through the tenant's way out (mailbox integration; a demo tenant only the sink — rule 24, also
-- enforced by mail_outbox_demo_sink_only). It concerns no customer and no template, like the auth
-- mails.
ALTER TABLE mail_outbox DROP CONSTRAINT mail_outbox_kind_check;
ALTER TABLE mail_outbox ADD CONSTRAINT mail_outbox_kind_check
  CHECK (kind IN ('invitation', 'password_reset', 'reminder', 'dunning', 'statement', 'document',
                  'reply', 'test'));
ALTER TABLE mail_outbox DROP CONSTRAINT mail_outbox_collection_refs;
ALTER TABLE mail_outbox ADD CONSTRAINT mail_outbox_collection_refs
  CHECK ((kind IN ('invitation', 'password_reset', 'test')) = (customer_id IS NULL AND template_id IS NULL));
