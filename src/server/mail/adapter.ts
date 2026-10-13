import { randomUUID } from 'node:crypto';
import { createTranslator } from 'next-intl';
import en from '../../../messages/en.json' with { type: 'json' };
import sr from '../../../messages/sr-Latn.json' with { type: 'json' };
import { isLocale, type Locale } from '@/i18n/config';
import { logEvent } from '@/lib/log';
import type { MasterKeyring } from '@/server/crypto/keyring';
import { currentTenantId, type Queryable } from '@/server/crypto/subject-keys';
import { openMail, sealMail } from './crypto';

/**
 * Outgoing e-mail (ADR 0004). Every mail is written to mail_outbox inside the caller's tenant
 * transaction — recipient and body encrypted, never in a log.
 *
 * Transports:
 *   - sink: captured in mail_outbox, never delivered (demo tenant, tests, and — until SMTP
 *     exists — every tenant);
 *   - smtp: queued (status 'pending') for the outbox worker (1.3). There is no SMTP sender yet:
 *     nodemailer is not a dependency (BACKLOG), so `smtpEnabled` is false everywhere;
 *   - integration (4.2): collection mail of a non-demo tenant with an active mailbox integration
 *     goes to n8n (src/server/mail/dispatch-integration.ts), which sends it over the tenant's
 *     own mailbox (Google Workspace, Microsoft 365, IMAP/SMTP).
 *
 * Rule 24: a demo tenant ALWAYS uses the sink — here and in the database trigger
 * mail_outbox_demo_sink_only (migration 006).
 */

export type AuthMailKind = 'invitation' | 'password_reset';
/** Collection mail (3.3, migration 017): rendered from a tenant template, about one customer. */
export type CollectionMailKind = 'reminder' | 'dunning' | 'statement' | 'document' | 'reply';
export type MailKind = AuthMailKind | CollectionMailKind;
export type Transport = 'sink' | 'smtp' | 'integration';

export type OutgoingMail =
  | { kind: 'invitation'; to: string; locale: string; url: string; tenantName: string }
  | { kind: 'password_reset'; to: string; locale: string; url: string };

export type CollectionMail = {
  kind: CollectionMailKind;
  to: string;
  /** Rendered by src/server/templates (whitelisted variables, escaped values). */
  subject: string;
  html: string;
  customerId: string;
  /** NULL for a free-text reply written by a member (4.2). */
  templateId: string | null;
  sourceRunId?: string | null;
  caseId?: string | null;
  /** Threading (4.2): the received mail this answers. */
  inReplyTo?: { inboxId: string; messageId: string; references: string[] } | null;
};

export type CapturedMail = {
  id: string;
  kind: MailKind;
  transport: Transport;
  to: string;
  subject: string;
  text: string;
  /** Collection mail only: the rendered HTML body. */
  html: string | null;
  customerId: string | null;
  createdAt: Date;
};

export type MailOptions = { smtpEnabled?: boolean };

const MESSAGES = { 'sr-Latn': sr, en } as const;

export function selectTransport(input: { isDemo: boolean; smtpEnabled: boolean }): Transport {
  if (input.isDemo) return 'sink';
  return input.smtpEnabled ? 'smtp' : 'sink';
}

function render(mail: OutgoingMail): { subject: string; text: string } {
  const locale: Locale = isLocale(mail.locale) ? mail.locale : 'en';
  const t = createTranslator({ locale, messages: MESSAGES[locale], namespace: 'mail' });
  if (mail.kind === 'invitation') {
    return {
      subject: t('invitation.subject', { tenant: mail.tenantName }),
      text: t('invitation.text', { tenant: mail.tenantName, url: mail.url }),
    };
  }
  return { subject: t('passwordReset.subject'), text: t('passwordReset.text', { url: mail.url }) };
}

async function transportFor(db: Queryable, tenantId: string, options: MailOptions) {
  const { rows } = await db.query<{ is_demo: boolean }>(
    'SELECT is_demo FROM tenants WHERE id = $1',
    [tenantId],
  );
  return selectTransport({
    isDemo: rows[0]?.is_demo ?? true, // unknown → the safe side
    smtpEnabled: options.smtpEnabled ?? false,
  });
}

function messageIdDomain(): string {
  try {
    return new URL(process.env.BETTER_AUTH_URL ?? '').hostname || 'collect.invalid';
  } catch {
    return 'collect.invalid';
  }
}

/**
 * Collection mail way out (4.2): a demo tenant → sink (rule 24); otherwise the tenant's active
 * mailbox integration (n8n) when there is one; otherwise the sink.
 */
async function collectionTransport(
  db: Queryable,
  tenantId: string,
  options: MailOptions,
): Promise<{ transport: Transport; integrationId: string | null }> {
  const base = await transportFor(db, tenantId, options);
  const demo = await db.query<{ is_demo: boolean }>('SELECT is_demo FROM tenants WHERE id = $1', [
    tenantId,
  ]);
  if (demo.rows[0]?.is_demo ?? true) return { transport: 'sink', integrationId: null };
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM integrations WHERE type = 'mailbox' AND status = 'active' AND config ? 'outboundUrl'
     ORDER BY created_at LIMIT 1`,
  );
  return rows[0]
    ? { transport: 'integration', integrationId: rows[0].id }
    : { transport: base, integrationId: null };
}

async function insertOutbox(
  db: Queryable,
  keyring: MasterKeyring,
  tenantId: string,
  transport: Transport,
  mail: {
    kind: MailKind;
    to: string;
    body: {
      subject: string;
      text: string;
      html?: string;
      inReplyTo?: string;
      references?: string[];
    };
    customerId?: string | null;
    templateId?: string | null;
    sourceRunId?: string | null;
    integrationId?: string | null;
    caseId?: string | null;
    inReplyToId?: string | null;
  },
): Promise<string> {
  const id = randomUUID();
  // Our own Message-ID (threading of replies, 4.2); a provider may report its real one later.
  const messageId = mail.integrationId ? `<${id}@${messageIdDomain()}>` : null;
  const sealedRecipient = sealMail(keyring, tenantId, 'recipient', id, mail.to);
  const sealedBody = sealMail(keyring, tenantId, 'body', id, JSON.stringify(mail.body));
  await db.query(
    `INSERT INTO mail_outbox (id, tenant_id, kind, transport, status, recipient_enc,
                              recipient_key_version, body_enc, body_key_version,
                              customer_id, template_id, source_run_id, integration_id, case_id,
                              in_reply_to_id, message_id, next_attempt_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
             CASE WHEN $4 = 'integration' THEN now() END)`,
    [
      id,
      tenantId,
      mail.kind,
      transport,
      transport === 'sink' ? 'captured' : 'pending',
      sealedRecipient.ciphertext,
      sealedRecipient.keyVersion,
      sealedBody.ciphertext,
      sealedBody.keyVersion,
      mail.customerId ?? null,
      mail.templateId ?? null,
      mail.sourceRunId ?? null,
      mail.integrationId ?? null,
      mail.caseId ?? null,
      mail.inReplyToId ?? null,
      messageId,
    ],
  );
  logEvent(transport === 'sink' ? 'mail.captured' : 'mail.queued', {
    outboxId: id,
    tenantId,
    kind: mail.kind,
    transport,
  });
  return id;
}

/** Writes the mail to mail_outbox of the CURRENT tenant (app_tenant_id()). */
export async function sendMail(
  db: Queryable,
  keyring: MasterKeyring,
  mail: OutgoingMail,
  options: MailOptions = {},
): Promise<{ id: string; transport: Transport }> {
  const tenantId = await currentTenantId(db);
  const transport = await transportFor(db, tenantId, options);
  const id = await insertOutbox(db, keyring, tenantId, transport, {
    kind: mail.kind,
    to: mail.to,
    body: render(mail),
  });
  return { id, transport };
}

/** Plain-text alternative of a rendered (whitelisted-tag, escaped) template body. */
export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|h[1-3]|li|tr|div|table|ul|ol)>/gi, '\n')
    .replace(/<\/t[dh]>/gi, '\t')
    .replace(/<li>/gi, '- ')
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Collection mail (3.3): a rendered template to a customer's contact, in the CURRENT tenant.
 * Same transports and rule 24 as sendMail — until SMTP exists every tenant uses the sink.
 */
export async function sendCollectionMail(
  db: Queryable,
  keyring: MasterKeyring,
  mail: CollectionMail,
  options: MailOptions = {},
): Promise<{ id: string; transport: Transport }> {
  const tenantId = await currentTenantId(db);
  const { transport, integrationId } = await collectionTransport(db, tenantId, options);
  const body = {
    subject: mail.subject,
    text: htmlToText(mail.html),
    html: mail.html,
    ...(mail.inReplyTo
      ? { inReplyTo: mail.inReplyTo.messageId, references: mail.inReplyTo.references }
      : {}),
  };
  const id = await insertOutbox(db, keyring, tenantId, transport, {
    kind: mail.kind,
    to: mail.to,
    body,
    customerId: mail.customerId,
    templateId: mail.templateId,
    sourceRunId: mail.sourceRunId ?? null,
    integrationId,
    caseId: mail.caseId ?? null,
    inReplyToId: mail.inReplyTo?.inboxId ?? null,
  });
  return { id, transport };
}

type OutboxRow = {
  id: string;
  kind: MailKind;
  transport: Transport;
  recipient_enc: Buffer;
  recipient_key_version: number;
  body_enc: Buffer;
  body_key_version: number;
  customer_id: string | null;
  created_at: Date;
};

/** Decrypted mail of the CURRENT tenant, newest first (sink viewer, tests). */
export async function readOutbox(
  db: Queryable,
  keyring: MasterKeyring,
  filter: { kind?: MailKind; limit?: number } = {},
): Promise<CapturedMail[]> {
  const tenantId = await currentTenantId(db);
  const { rows } = await db.query<OutboxRow>(
    `SELECT id, kind, transport, recipient_enc, recipient_key_version, body_enc,
            body_key_version, customer_id, created_at
     FROM mail_outbox
     WHERE ($1::text IS NULL OR kind = $1)
     ORDER BY created_at DESC, id
     LIMIT $2`,
    [filter.kind ?? null, filter.limit ?? 50],
  );
  return rows.map((r) => {
    const body = JSON.parse(
      openMail(keyring, tenantId, 'body', r.id, {
        ciphertext: r.body_enc,
        keyVersion: r.body_key_version,
      }),
    ) as { subject: string; text: string; html?: string };
    return {
      id: r.id,
      kind: r.kind,
      transport: r.transport,
      to: openMail(keyring, tenantId, 'recipient', r.id, {
        ciphertext: r.recipient_enc,
        keyVersion: r.recipient_key_version,
      }),
      subject: body.subject,
      text: body.text,
      html: body.html ?? null,
      customerId: r.customer_id,
      createdAt: r.created_at,
    };
  });
}
