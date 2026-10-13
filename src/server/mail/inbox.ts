import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { logEvent } from '@/lib/log';
import { emailBlindIndex, type Queryable } from '@/server/crypto/subject-keys';
import { emitEvent } from '@/server/events';
import { seal } from '@/server/integrations/crypto';
import { parsePayload, PayloadError, type WebhookContext } from '@/server/integrations/process';
import { htmlToText } from './adapter';

/**
 * Received mail (task 4.2) — handlers of the inbound webhook types `mail.received` and
 * `mail.status`. UNTRUSTED INPUT (rule 22): the content is stored (encrypted) and shown as text;
 * nothing in it is ever parsed for commands, rendered as a template, or used to call a tool.
 * The only things derived from a message are deterministic: the sender's blind index (→ customer
 * contact), the Message-IDs it references (→ our mail → case) and the bounce rule below.
 *
 * Linking, in this order:
 *   1. In-Reply-To / References → our mail_outbox.message_id → its customer and case;
 *   2. sender e-mail → blind index of the tenant (same key as customer_contacts.email) → exactly
 *      one customer (ambiguous = left for a person);
 *   3. otherwise status 'new' → Admin → Integrations → "Unlinked messages".
 * Bounce: a message from mailer-daemon / postmaster that references one of our sent mails marks
 * that mail 'bounced' (+ attention item); the notice itself is stored as ignored.
 */

const MESSAGE_ID = z.string().trim().min(3).max(998);
const LIMITS = { subject: 1_000, body: 100_000 } as const;

/** "Name <a@b.c>" or "a@b.c" → lower-case address, or null. */
export function senderAddress(value: string): string | null {
  const m = /<([^<>\s]+@[^<>\s]+)>/.exec(value);
  const raw = (m?.[1] ?? value).trim().toLowerCase();
  return z.email().safeParse(raw).success ? raw : null;
}

const receivedSchema = z.object({
  messageId: MESSAGE_ID,
  from: z.string().min(3).max(500),
  subject: z.string().max(10_000).default(''),
  text: z.string().max(2_000_000).default(''),
  html: z.string().max(5_000_000).nullish(),
  inReplyTo: MESSAGE_ID.nullish(),
  references: z.array(MESSAGE_ID).max(100).default([]),
  attachments: z
    .array(
      z.object({
        filename: z.string().max(255),
        contentType: z.string().max(255),
        size: z.number().int().min(0).max(1_000_000_000),
      }),
    )
    .max(50)
    .default([]),
});

const statusSchema = z.object({
  outboxId: z.uuid(),
  status: z.enum(['sent', 'failed', 'bounced']),
  messageId: MESSAGE_ID.nullish(),
  reason: z
    .string()
    .regex(/^[a-z][a-z0-9_.]{1,62}$/)
    .nullish(),
});

const BOUNCE_SENDER = /^(mailer-daemon|postmaster)@/;
const ANGLE_IDS = /<[^<>\s]{3,300}@[^<>\s]{1,300}>/g;

async function ourMail(
  db: Queryable,
  ids: string[],
): Promise<{
  id: string;
  customer_id: string | null;
  case_id: string | null;
  status: string;
} | null> {
  if (!ids.length) return null;
  const { rows } = await db.query<{
    id: string;
    customer_id: string | null;
    case_id: string | null;
    status: string;
  }>(
    `SELECT id, customer_id, case_id, status FROM mail_outbox
     WHERE message_id = ANY($1::text[]) ORDER BY created_at DESC LIMIT 1`,
    [ids],
  );
  return rows[0] ?? null;
}

export async function handleMailReceived(
  ctx: WebhookContext,
  data: Record<string, unknown>,
): Promise<Record<string, number>> {
  const mail = parsePayload(receivedSchema, data);
  const from = senderAddress(mail.from);
  if (!from) throw new PayloadError('sender is not an e-mail address');
  const text = (mail.text.trim() || htmlToText(mail.html ?? '')).slice(0, LIMITS.body);
  const subject = mail.subject.slice(0, LIMITS.subject);
  const refs = [
    ...new Set([mail.inReplyTo, ...mail.references].filter((x): x is string => Boolean(x))),
  ];

  // 1 / bounce — referenced mail of ours (bounce notices quote the Message-ID in the body).
  const isBounce = BOUNCE_SENDER.test(from);
  const quoted = isBounce ? (text.match(ANGLE_IDS) ?? []).slice(0, 20) : [];
  const replied = await ourMail(ctx.db, [...refs, ...quoted]);

  let customerId: string | null = null;
  let contactId: string | null = null;
  let caseId: string | null = null;
  if (!isBounce && replied?.customer_id) {
    customerId = replied.customer_id;
    caseId = replied.case_id;
  }
  // 2 — sender → contact (blind index of THIS tenant; another tenant's contact cannot match).
  const idx = await emailBlindIndex(ctx.db, ctx.keyring, 'customer_contacts.email', from, {
    createKey: false,
  });
  if (!isBounce && idx) {
    const { rows } = await ctx.db.query<{ id: string; customer_id: string }>(
      `SELECT id, customer_id FROM customer_contacts
       WHERE email_bidx = $1 AND email_bidx_key_version = $2 AND status = 'active'`,
      [idx.bidx, idx.keyVersion],
    );
    const customers = new Set(rows.map((r) => r.customer_id));
    if (!customerId && customers.size === 1) customerId = rows[0]?.customer_id ?? null;
    if (customerId) contactId = rows.find((r) => r.customer_id === customerId)?.id ?? null;
  }

  const id = randomUUID();
  const sealed = (
    target: 'mail_inbox.from' | 'mail_inbox.subject' | 'mail_inbox.body',
    v: string,
  ) => seal(ctx.keyring, ctx.tenantId, target, id, v);
  const f = sealed('mail_inbox.from', from);
  const s = sealed('mail_inbox.subject', subject);
  const b = sealed('mail_inbox.body', text);
  const status = isBounce ? 'ignored' : customerId ? 'linked' : 'new';
  const ins = await ctx.db.query<{ id: string }>(
    `INSERT INTO mail_inbox (id, tenant_id, integration_id, external_message_id, from_enc, from_key_version, from_bidx,
                             from_bidx_key_version, subject_enc, subject_key_version, body_enc, body_key_version,
                             received_at, customer_id, contact_id, case_id, reply_to_outbox_id, thread_key, in_reply_to,
                             status, is_bounce, attachments, webhook_event_id)
     VALUES ($1, app_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
             $21, $22)
     ON CONFLICT (tenant_id, external_message_id) DO NOTHING RETURNING id`,
    [
      id,
      ctx.integrationId,
      mail.messageId,
      f.ciphertext,
      f.keyVersion,
      idx?.bidx ?? null,
      idx?.keyVersion ?? null,
      s.ciphertext,
      s.keyVersion,
      b.ciphertext,
      b.keyVersion,
      ctx.receivedAt,
      customerId,
      contactId,
      caseId,
      replied?.id ?? null,
      mail.references[0] ?? mail.inReplyTo ?? mail.messageId,
      mail.inReplyTo ?? null,
      status,
      isBounce,
      JSON.stringify(mail.attachments),
      ctx.webhookEventId,
    ],
  );
  if (!ins.rows[0]) return { duplicate: 1 };

  let bounced = 0;
  if (isBounce && replied && replied.status === 'sent') {
    const ok = await ctx.db.query<{ ok: boolean }>(
      `SELECT mail_outbox_delivery($1, 'bounced', NULL, 'bounce_notice', NULL) AS ok`,
      [replied.id],
    );
    if (ok.rows[0]?.ok) {
      bounced = 1;
      await emitEvent(ctx.db, {
        eventType: 'mail.bounced',
        aggregateType: 'mail_outbox',
        aggregateId: replied.id,
        payload: { customer_id: replied.customer_id, source: 'bounce_notice' },
      });
    }
  }
  await emitEvent(ctx.db, {
    eventType: 'mail.received',
    aggregateType: 'mail_inbox',
    aggregateId: id,
    payload: {
      customer_id: customerId,
      case_id: caseId,
      linked: Boolean(customerId),
      bounce: isBounce,
    },
  });
  logEvent('mail.inbox_stored', {
    tenantId: ctx.tenantId,
    inboxId: id,
    linked: Boolean(customerId),
    bounce: isBounce,
  });
  return { received: 1, linked: customerId ? 1 : 0, bounced };
}

export async function handleMailStatus(
  ctx: WebhookContext,
  data: Record<string, unknown>,
): Promise<Record<string, number>> {
  const s = parsePayload(statusSchema, data);
  const { rows } = await ctx.db.query<{ ok: boolean }>(
    'SELECT mail_outbox_delivery($1, $2, $3, $4, NULL) AS ok',
    [s.outboxId, s.status, s.messageId ?? null, s.reason ?? null],
  );
  const ok = rows[0]?.ok ?? false;
  if (ok && s.status !== 'sent') {
    const cust = await ctx.db.query<{ customer_id: string | null }>(
      'SELECT customer_id FROM mail_outbox WHERE id = $1',
      [s.outboxId],
    );
    await emitEvent(ctx.db, {
      eventType: s.status === 'bounced' ? 'mail.bounced' : 'mail.failed',
      aggregateType: 'mail_outbox',
      aggregateId: s.outboxId,
      payload: { customer_id: cust.rows[0]?.customer_id ?? null, source: 'status_webhook' },
    });
  }
  return { updated: ok ? 1 : 0, ignored: ok ? 0 : 1 };
}
