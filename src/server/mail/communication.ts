import { z } from 'zod';
import { permissionKeys } from '@/server/auth/permissions';
import { scopeFilter } from '@/server/auth/scope';
import {
  ConflictError,
  InvalidRequestError,
  NotFoundError,
  type TenantContext,
} from '@/server/auth/with-tenant';
import { createActivity } from '@/server/collections/service';
import { getMasterKeyring, type MasterKeyring } from '@/server/crypto/keyring';
import { mailContact } from '@/server/customers/repository';
import { emitEvent } from '@/server/events';
import { open } from '@/server/integrations/crypto';
import { renderForCustomer } from '@/server/templates/service';
import { escapeHtml } from '@/server/templates/render';
import { openMail } from './crypto';
import { sendCollectionMail } from './adapter';

/**
 * Customer 360 → Communication (task 4.2): one thread per customer — mail we sent (mail_outbox),
 * mail we received (mail_inbox) and logged activities — newest first. Reading: activity.read
 * within the customer's scope; addresses only with contact.read. Received text is UNTRUSTED
 * (rule 22): it goes out as plain text and the UI shows links inactive (src/lib/untrusted-text).
 * Replying (activity.create): a template or free text, to the sender of the answered message or
 * the customer's mail contact; it is threaded (In-Reply-To/References) and logged as an activity.
 */

export type ThreadItem = {
  id: string;
  direction: 'out' | 'in' | 'activity';
  at: string;
  kind: string;
  subject: string | null;
  text: string | null;
  status: string | null;
  address: string | null;
  caseId: string | null;
  actorName: string | null;
};

async function scoped(ctx: TenantContext, customerId: string, permission: string) {
  const { scope } = await ctx.requirePermission(permission);
  const filter = scopeFilter('customers', { userId: ctx.userId, scope }, 'c', 2);
  const { rows } = await ctx.db.query<{ id: string }>(
    `SELECT c.id FROM customers c WHERE c.id = $1 AND ${filter.sql}`,
    [customerId, ...filter.params],
  );
  if (!rows.length) throw new NotFoundError();
}

export async function listThread(
  ctx: TenantContext,
  customerId: string,
  keyring: MasterKeyring = getMasterKeyring(),
  limit = 100,
): Promise<ThreadItem[]> {
  await scoped(ctx, customerId, 'activity.read');
  const seeAddress = (await permissionKeys(ctx.db, ctx.userId)).has('contact.read');
  const out = await ctx.db.query<{
    id: string;
    kind: string;
    status: string;
    created_at: Date;
    case_id: string | null;
    recipient_enc: Buffer;
    recipient_key_version: number;
    body_enc: Buffer;
    body_key_version: number;
  }>(
    `SELECT id, kind, status, created_at, case_id, recipient_enc, recipient_key_version, body_enc, body_key_version
     FROM mail_outbox WHERE customer_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [customerId, limit],
  );
  const inbox = await ctx.db.query<{
    id: string;
    received_at: Date;
    case_id: string | null;
    from_enc: Buffer;
    from_key_version: number;
    subject_enc: Buffer;
    subject_key_version: number;
    body_enc: Buffer;
    body_key_version: number;
  }>(
    `SELECT id, received_at, case_id, from_enc, from_key_version, subject_enc, subject_key_version, body_enc,
            body_key_version
     FROM mail_inbox WHERE customer_id = $1 AND NOT is_bounce ORDER BY received_at DESC LIMIT $2`,
    [customerId, limit],
  );
  const acts = await ctx.db.query<{
    id: string;
    kind: string;
    occurred_at: Date;
    case_id: string | null;
    actor: string | null;
  }>(
    `SELECT a.id, a.kind, a.occurred_at, a.case_id, u.display_name AS actor FROM activities a
     LEFT JOIN users u ON u.id = a.actor_user_id
     WHERE a.customer_id = $1 AND a.kind <> 'email' ORDER BY a.occurred_at DESC LIMIT $2`,
    [customerId, limit],
  );
  const items: ThreadItem[] = [];
  for (const m of out.rows) {
    const body = JSON.parse(
      openMail(keyring, ctx.tenantId, 'body', m.id, {
        ciphertext: m.body_enc,
        keyVersion: m.body_key_version,
      }),
    ) as { subject: string; text: string };
    items.push({
      id: m.id,
      direction: 'out',
      at: m.created_at.toISOString(),
      kind: m.kind,
      subject: body.subject,
      text: body.text,
      status: m.status,
      address: seeAddress
        ? openMail(keyring, ctx.tenantId, 'recipient', m.id, {
            ciphertext: m.recipient_enc,
            keyVersion: m.recipient_key_version,
          })
        : null,
      caseId: m.case_id,
      actorName: null,
    });
  }
  for (const m of inbox.rows) {
    const dec = (
      target: 'mail_inbox.from' | 'mail_inbox.subject' | 'mail_inbox.body',
      c: Buffer,
      v: number,
    ) => open(keyring, ctx.tenantId, target, m.id, { ciphertext: c, keyVersion: v });
    items.push({
      id: m.id,
      direction: 'in',
      at: m.received_at.toISOString(),
      kind: 'received',
      subject: dec('mail_inbox.subject', m.subject_enc, m.subject_key_version),
      text: dec('mail_inbox.body', m.body_enc, m.body_key_version),
      status: null,
      address: seeAddress ? dec('mail_inbox.from', m.from_enc, m.from_key_version) : null,
      caseId: m.case_id,
      actorName: null,
    });
  }
  for (const a of acts.rows) {
    items.push({
      id: a.id,
      direction: 'activity',
      at: a.occurred_at.toISOString(),
      kind: a.kind,
      subject: null,
      text: null,
      status: null,
      address: null,
      caseId: a.case_id,
      actorName: a.actor,
    });
  }
  return items.sort((x, y) => y.at.localeCompare(x.at)).slice(0, limit);
}

export const messageSchema = z
  .object({
    templateKey: z
      .string()
      .regex(/^[a-z][a-z0-9_]{1,62}$/)
      .optional(),
    subject: z.string().trim().min(1).max(300).optional(),
    body: z.string().trim().min(1).max(20_000).optional(),
    replyToInboxId: z.uuid().optional(),
    caseId: z.uuid().optional(),
  })
  .refine((v) => Boolean(v.templateKey) !== Boolean(v.subject && v.body), {
    path: ['templateKey'],
  });

/** Free text → paragraphs of escaped text (no markup from the member either). */
function textToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

export async function sendMessage(
  ctx: TenantContext,
  customerId: string,
  input: z.input<typeof messageSchema>,
  keyring: MasterKeyring = getMasterKeyring(),
): Promise<{ id: string; transport: string }> {
  const data = messageSchema.parse(input);
  await scoped(ctx, customerId, 'activity.create');

  let to: string | null = null;
  let caseId = data.caseId ?? null;
  let reply: { inboxId: string; messageId: string; references: string[] } | null = null;
  if (data.replyToInboxId) {
    const { rows } = await ctx.db.query<{
      id: string;
      external_message_id: string;
      thread_key: string;
      case_id: string | null;
      from_enc: Buffer;
      from_key_version: number;
    }>(
      `SELECT id, external_message_id, thread_key, case_id, from_enc, from_key_version FROM mail_inbox
       WHERE id = $1 AND customer_id = $2 AND NOT is_bounce`,
      [data.replyToInboxId, customerId],
    );
    const m = rows[0];
    if (!m) throw new NotFoundError();
    to = open(keyring, ctx.tenantId, 'mail_inbox.from', m.id, {
      ciphertext: m.from_enc,
      keyVersion: m.from_key_version,
    });
    caseId = caseId ?? m.case_id;
    reply = {
      inboxId: m.id,
      messageId: m.external_message_id,
      references: [...new Set([m.thread_key, m.external_message_id])],
    };
  } else {
    to = (await mailContact(ctx.db, keyring, customerId))?.email ?? null;
  }
  if (!to) throw new ConflictError('conflict');
  if (caseId) {
    const k = await ctx.db.query(
      'SELECT 1 FROM collection_cases WHERE id = $1 AND customer_id = $2',
      [caseId, customerId],
    );
    if (!k.rowCount) throw new NotFoundError();
  }

  let subject: string;
  let html: string;
  let kind: 'reply' | 'reminder' | 'dunning' = 'reply';
  let templateId: string | null = null;
  if (data.templateKey) {
    const r = await renderForCustomer(
      ctx,
      { key: data.templateKey, channel: 'email', customerId, permission: 'activity.create' },
      keyring,
    );
    subject = r.subject;
    html = r.html;
    templateId = r.templateId;
    kind = r.hasLegalEffect ? 'dunning' : 'reminder';
  } else {
    if (!data.subject || !data.body) throw new InvalidRequestError();
    subject = data.subject;
    html = textToHtml(data.body);
  }
  const mail = await sendCollectionMail(ctx.db, keyring, {
    kind,
    to,
    subject,
    html,
    customerId,
    templateId,
    caseId,
    inReplyTo: reply,
  });
  // The thread and the case timeline see it; the activity records who wrote (subject only).
  await createActivity(
    ctx,
    { customerId, caseId: caseId ?? undefined, kind: 'email', note: subject },
    keyring,
  );
  if (reply) {
    await ctx.db.query(
      `UPDATE mail_inbox SET status = 'linked', updated_by = $2 WHERE id = $1 AND status = 'new'`,
      [reply.inboxId, ctx.userId],
    );
  }
  await ctx.audit({
    action: 'mail.sent_by_member',
    entityType: 'mail_outbox',
    entityId: mail.id,
    after: { kind, transport: mail.transport, customer_id: customerId, case_id: caseId },
  });
  await emitEvent(ctx.db, {
    eventType: 'mail.queued',
    aggregateType: 'mail_outbox',
    aggregateId: mail.id,
    payload: { customer_id: customerId, kind, transport: mail.transport },
    requestId: ctx.requestId,
    actorId: ctx.userId,
  });
  return mail;
}

// ---------------------------------------------------------------------------------------------
// Unlinked messages (Admin → Integrations)
// ---------------------------------------------------------------------------------------------

export type UnlinkedMessage = {
  id: string;
  receivedAt: string;
  subject: string;
  /** Full address with contact.read, otherwise only the domain. */
  sender: string;
};

export async function listUnlinked(
  ctx: TenantContext,
  keyring: MasterKeyring = getMasterKeyring(),
): Promise<UnlinkedMessage[]> {
  await ctx.requirePermission('integration.read');
  const seeAddress = (await permissionKeys(ctx.db, ctx.userId)).has('contact.read');
  const { rows } = await ctx.db.query<{
    id: string;
    received_at: Date;
    from_enc: Buffer;
    from_key_version: number;
    subject_enc: Buffer;
    subject_key_version: number;
  }>(
    `SELECT id, received_at, from_enc, from_key_version, subject_enc, subject_key_version FROM mail_inbox
     WHERE status = 'new' ORDER BY received_at DESC LIMIT 100`,
  );
  return rows.map((r) => {
    const from = open(keyring, ctx.tenantId, 'mail_inbox.from', r.id, {
      ciphertext: r.from_enc,
      keyVersion: r.from_key_version,
    });
    return {
      id: r.id,
      receivedAt: r.received_at.toISOString(),
      subject: open(keyring, ctx.tenantId, 'mail_inbox.subject', r.id, {
        ciphertext: r.subject_enc,
        keyVersion: r.subject_key_version,
      }),
      sender: seeAddress ? from : `…@${from.split('@')[1] ?? ''}`,
    };
  });
}

export const linkSchema = z.union([
  z.object({ customerId: z.uuid() }),
  z.object({ ignore: z.literal(true) }),
]);

/** A person links an unlinked message to a customer (in scope) or ignores it. */
export async function linkMessage(
  ctx: TenantContext,
  inboxId: string,
  input: z.input<typeof linkSchema>,
): Promise<{ ok: true }> {
  await ctx.requirePermission('integration.manage');
  const data = linkSchema.parse(input);
  const found = await ctx.db.query<{ status: string }>(
    'SELECT status FROM mail_inbox WHERE id = $1',
    [inboxId],
  );
  if (!found.rows[0]) throw new NotFoundError();
  if (found.rows[0].status !== 'new') throw new ConflictError('conflict');
  if ('customerId' in data) {
    await scoped(ctx, data.customerId, 'customer.read');
    await ctx.db.query(
      `UPDATE mail_inbox SET status = 'linked', customer_id = $2, linked_by = $3, updated_by = $3 WHERE id = $1`,
      [inboxId, data.customerId, ctx.userId],
    );
  } else {
    await ctx.db.query(`UPDATE mail_inbox SET status = 'ignored', updated_by = $2 WHERE id = $1`, [
      inboxId,
      ctx.userId,
    ]);
  }
  await ctx.audit({
    action: 'mail_inbox.linked',
    entityType: 'mail_inbox',
    entityId: inboxId,
    after:
      'customerId' in data
        ? { status: 'linked', customer_id: data.customerId }
        : { status: 'ignored' },
  });
  return { ok: true };
}

/** E-mail templates a member may send from the thread (names only, no text). */
export async function emailTemplateOptions(
  ctx: TenantContext,
): Promise<{ key: string; name: string; hasLegalEffect: boolean }[]> {
  await ctx.requirePermission('activity.create');
  const { rows } = await ctx.db.query<{ key: string; name: string; has_legal_effect: boolean }>(
    `SELECT key, name, has_legal_effect FROM templates WHERE channel = 'email' AND status = 'active' ORDER BY name`,
  );
  return rows.map((r) => ({ key: r.key, name: r.name, hasLegalEffect: r.has_legal_effect }));
}

/** Customers to link an unlinked message to (companies by name; natural persons are linked from
 * their own Customer 360 by replying — their names are encrypted). */
export async function linkTargets(ctx: TenantContext): Promise<{ id: string; name: string }[]> {
  const { scope } = await ctx.requirePermission('customer.read');
  const filter = scopeFilter('customers', { userId: ctx.userId, scope }, 'c', 1);
  const { rows } = await ctx.db.query<{ id: string; name: string }>(
    `SELECT c.id, c.display_name AS name FROM customers c
     WHERE c.display_name IS NOT NULL AND c.status <> 'inactive' AND ${filter.sql}
     ORDER BY c.display_name LIMIT 500`,
    filter.params,
  );
  return rows;
}
