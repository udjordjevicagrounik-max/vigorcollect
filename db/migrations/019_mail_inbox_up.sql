-- 019_mail_inbox_up.sql — Sprint 4.2: e-mail as communication. Protected (rule 13).
--
-- 1. mail_inbox: received mail (through the n8n integration). Sender, subject and body are
--    UNTRUSTED input (rule 22) and personal data — stored encrypted (HKDF key per tenant, like
--    mail_outbox); the sender is matched to a customer contact through the SAME blind index as
--    customer_contacts.email (per tenant — another tenant's contact can never match).
-- 2. mail_outbox learns delivery through an integration: transport 'integration', status
--    'bounced', kind 'reply' (free text from Customer 360), Message-ID for threading, the case,
--    attempts/backoff. CHECK replacements are supersets/relaxations with the same names (pattern
--    of 017, ADR 0003 "Zamena CHECK-a"): no row changes and every existing row stays valid.
-- 3. Delivery status changes go through mail_outbox_delivery() — the app role still cannot
--    UPDATE mail_outbox directly (006); the function allows only the legal transitions.

-- ============================================================================================
-- mail_outbox: integration transport, bounce, reply, threading, case
-- ============================================================================================

ALTER TABLE mail_outbox DROP CONSTRAINT mail_outbox_kind_check;
ALTER TABLE mail_outbox ADD CONSTRAINT mail_outbox_kind_check
  CHECK (kind IN ('invitation', 'password_reset', 'reminder', 'dunning', 'statement', 'document', 'reply'));

ALTER TABLE mail_outbox DROP CONSTRAINT mail_outbox_transport_check;
ALTER TABLE mail_outbox ADD CONSTRAINT mail_outbox_transport_check
  CHECK (transport IN ('sink', 'smtp', 'integration'));

ALTER TABLE mail_outbox DROP CONSTRAINT mail_outbox_status_check;
ALTER TABLE mail_outbox ADD CONSTRAINT mail_outbox_status_check
  CHECK (status IN ('captured', 'pending', 'sent', 'failed', 'bounced'));

-- A bounced mail was sent first: sent_at stays. Old rule ((status='sent') = (sent_at IS NOT NULL))
-- relaxed to: sent ⇒ sent_at; sent_at only for sent or bounced.
ALTER TABLE mail_outbox DROP CONSTRAINT mail_outbox_sent_at;
ALTER TABLE mail_outbox ADD CONSTRAINT mail_outbox_sent_at
  CHECK ((status <> 'sent' OR sent_at IS NOT NULL) AND (sent_at IS NULL OR status IN ('sent', 'bounced')));

ALTER TABLE mail_outbox
  ADD COLUMN integration_id   uuid,
  ADD COLUMN case_id          uuid,
  -- RFC 5322 Message-ID we (or the provider, reported back by n8n) gave the mail.
  ADD COLUMN message_id       text CHECK (length(message_id) BETWEEN 3 AND 998),
  ADD COLUMN in_reply_to_id   uuid,
  ADD COLUMN attempts         integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  ADD COLUMN next_attempt_at  timestamptz,
  ADD COLUMN status_reason    text CHECK (status_reason ~ '^[a-z][a-z0-9_.]{1,62}$'),
  ADD COLUMN bounced_at       timestamptz,
  ADD CONSTRAINT mail_outbox_integration FOREIGN KEY (tenant_id, integration_id) REFERENCES integrations (tenant_id, id),
  ADD CONSTRAINT mail_outbox_case FOREIGN KEY (tenant_id, case_id) REFERENCES collection_cases (tenant_id, id),
  ADD CONSTRAINT mail_outbox_integration_transport CHECK ((transport = 'integration') = (integration_id IS NOT NULL)),
  ADD CONSTRAINT mail_outbox_bounced CHECK ((status = 'bounced') = (bounced_at IS NOT NULL));
-- Replies are threaded by Message-ID within a tenant.
CREATE INDEX mail_outbox_message_id ON mail_outbox (tenant_id, message_id) WHERE message_id IS NOT NULL;
CREATE INDEX mail_outbox_due ON mail_outbox (tenant_id, next_attempt_at)
  WHERE transport = 'integration' AND status = 'pending';

-- Delivery status by the integration dispatcher / status webhook, in the CURRENT tenant only.
--   pending → pending (one more attempt, backoff) | sent | failed;  sent → bounced
CREATE FUNCTION mail_outbox_delivery(
  p_id uuid, p_status text, p_message_id text, p_reason text, p_next_attempt_at timestamptz
) RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_catalog
AS $$
DECLARE
  cur text;
BEGIN
  IF app_tenant_id() IS NULL THEN
    RAISE EXCEPTION 'mail_outbox_delivery requires a tenant context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT status INTO cur FROM mail_outbox
  WHERE id = p_id AND tenant_id = app_tenant_id() AND transport = 'integration' FOR UPDATE;
  IF cur IS NULL THEN
    RETURN false;
  END IF;
  IF NOT ((cur = 'pending' AND p_status IN ('pending', 'sent', 'failed')) OR (cur = 'sent' AND p_status = 'bounced')) THEN
    RETURN false;
  END IF;
  UPDATE mail_outbox SET
    status = p_status,
    attempts = attempts + CASE WHEN cur = 'pending' THEN 1 ELSE 0 END,
    next_attempt_at = CASE WHEN p_status = 'pending' THEN p_next_attempt_at END,
    sent_at = CASE WHEN p_status = 'sent' THEN now() ELSE sent_at END,
    bounced_at = CASE WHEN p_status = 'bounced' THEN now() END,
    message_id = coalesce(p_message_id, message_id),
    status_reason = p_reason
  WHERE id = p_id AND tenant_id = app_tenant_id();
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION mail_outbox_delivery(uuid, text, text, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mail_outbox_delivery(uuid, text, text, text, timestamptz) TO vigor_app;

-- ============================================================================================
-- mail_inbox
-- ============================================================================================

CREATE TABLE mail_inbox (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid        NOT NULL REFERENCES tenants (id),
  integration_id         uuid        NOT NULL,
  external_message_id    text        NOT NULL CHECK (length(external_message_id) BETWEEN 1 AND 998),
  from_enc               bytea       NOT NULL,
  from_key_version       integer     NOT NULL CHECK (from_key_version >= 1),
  -- Blind index with the tenant's 'customer_contacts.email' key (equality with the contact).
  from_bidx              bytea       CHECK (octet_length(from_bidx) = 32),
  from_bidx_key_version  integer     CHECK (from_bidx_key_version >= 1),
  subject_enc            bytea       NOT NULL,
  subject_key_version    integer     NOT NULL CHECK (subject_key_version >= 1),
  body_enc               bytea       NOT NULL,
  body_key_version       integer     NOT NULL CHECK (body_key_version >= 1),
  received_at            timestamptz NOT NULL,
  customer_id            uuid,
  contact_id             uuid,
  case_id                uuid,
  -- Our mail this one answers (In-Reply-To / References → mail_outbox.message_id).
  reply_to_outbox_id     uuid,
  -- Root Message-ID of the conversation (References[0] / In-Reply-To / own id).
  thread_key             text        NOT NULL CHECK (length(thread_key) BETWEEN 1 AND 998),
  in_reply_to            text        CHECK (length(in_reply_to) <= 998),
  status                 text        NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'linked', 'ignored')),
  -- Delivery failure notice for one of our mails (mailer-daemon) — not a customer message.
  is_bounce              boolean     NOT NULL DEFAULT false,
  -- Attachment metadata only (name, type, size); content is not stored (BACKLOG).
  attachments            jsonb       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(attachments) = 'array'),
  webhook_event_id       uuid,
  linked_by              uuid,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  updated_by             uuid,
  CONSTRAINT mail_inbox_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT mail_inbox_once UNIQUE (tenant_id, external_message_id),
  CONSTRAINT mail_inbox_integration FOREIGN KEY (tenant_id, integration_id) REFERENCES integrations (tenant_id, id),
  CONSTRAINT mail_inbox_customer FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
  CONSTRAINT mail_inbox_contact FOREIGN KEY (tenant_id, contact_id) REFERENCES customer_contacts (tenant_id, id),
  CONSTRAINT mail_inbox_case FOREIGN KEY (tenant_id, case_id) REFERENCES collection_cases (tenant_id, id),
  CONSTRAINT mail_inbox_reply_to FOREIGN KEY (tenant_id, reply_to_outbox_id) REFERENCES mail_outbox (tenant_id, id),
  CONSTRAINT mail_inbox_webhook FOREIGN KEY (tenant_id, webhook_event_id) REFERENCES webhook_events (tenant_id, id),
  CONSTRAINT mail_inbox_bidx_pair CHECK ((from_bidx IS NULL) = (from_bidx_key_version IS NULL)),
  CONSTRAINT mail_inbox_linked CHECK ((status = 'linked') = (customer_id IS NOT NULL))
);
CREATE INDEX mail_inbox_customer ON mail_inbox (tenant_id, customer_id, received_at DESC) WHERE customer_id IS NOT NULL;
CREATE INDEX mail_inbox_unlinked ON mail_inbox (tenant_id, received_at DESC) WHERE status = 'new';
CREATE INDEX mail_inbox_thread ON mail_inbox (tenant_id, thread_key);
CREATE TRIGGER mail_inbox_updated_at BEFORE UPDATE ON mail_inbox
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE mail_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE mail_inbox FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mail_inbox
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

-- Received mail is history: linked / ignored by status, never deleted by the app (retention: BACKLOG).
REVOKE DELETE, TRUNCATE ON mail_inbox FROM vigor_app;

-- ============================================================================================
-- PII registry (rule 20)
-- ============================================================================================

INSERT INTO pii_field_registry
  (table_name, column_name, pii_class, conditional_on, conditional_pii_class, encrypted, exception_reason, purpose)
VALUES
  ('mail_inbox', 'from_enc', 'P1', NULL, NULL, true, NULL, 'sender e-mail address (untrusted input)'),
  ('mail_inbox', 'from_bidx', 'P1', NULL, NULL, false,
   'keyed HMAC blind index per tenant (ADR 0003); not reversible', 'match sender to a customer contact'),
  ('mail_inbox', 'subject_enc', 'P2', NULL, NULL, true, NULL, 'subject of a received e-mail (untrusted input)'),
  ('mail_inbox', 'body_enc', 'P3', NULL, NULL, true, NULL, 'text of a received e-mail (untrusted input)'),
  ('mail_inbox', 'external_message_id', 'P1', NULL, NULL, false,
   'RFC 5322 Message-ID may contain a host name; needed for exactly-once and threading', 'dedup and threading'),
  ('mail_inbox', 'thread_key', 'P1', NULL, NULL, false,
   'root Message-ID of the conversation; needed for threading', 'threading'),
  ('mail_inbox', 'in_reply_to', 'P1', NULL, NULL, false,
   'Message-ID of the answered mail; needed for threading', 'threading'),
  ('mail_outbox', 'message_id', 'P1', NULL, NULL, false,
   'RFC 5322 Message-ID of our mail; needed to thread replies', 'threading');

INSERT INTO pii_field_registry (table_name, column_name, pii_class, purpose)
SELECT c.table_name, c.column_name, 'P0', 'not personal data (registered by 019)'
FROM information_schema.columns c
WHERE c.table_schema = 'public'
  AND (c.table_name = 'mail_inbox'
       OR (c.table_name, c.column_name) IN (('mail_outbox', 'integration_id'), ('mail_outbox', 'case_id'),
                                            ('mail_outbox', 'in_reply_to_id'), ('mail_outbox', 'attempts'),
                                            ('mail_outbox', 'next_attempt_at'), ('mail_outbox', 'status_reason'),
                                            ('mail_outbox', 'bounced_at')))
ON CONFLICT (table_name, column_name) DO NOTHING;
