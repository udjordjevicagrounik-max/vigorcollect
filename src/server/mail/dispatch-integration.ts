import { z } from 'zod';
import { logEvent } from '@/lib/log';
import type { MasterKeyring } from '@/server/crypto/keyring';
import { currentTenantId, type Queryable } from '@/server/crypto/subject-keys';
import { emitEvent } from '@/server/events';
import {
  BACKOFF_SECONDS,
  MAX_ATTEMPTS,
  postSigned,
  type Fetch,
} from '@/server/integrations/outbound';
import { openMail } from './crypto';

/**
 * Collection mail through the tenant's mailbox integration (task 4.2), in the worker, per tenant
 * (withTenantJob). Each due row is decrypted here only, signed and POSTed to n8n as `mail.send`;
 * n8n answers 2xx AFTER sending, with the provider's Message-ID. Status goes through
 * mail_outbox_delivery() (the app role cannot UPDATE mail_outbox): sent, or one more attempt
 * with backoff, or failed after the last one. A demo tenant never has integration rows (the
 * adapter picks the sink; the database trigger refuses anything else, rule 24).
 */

const answerSchema = z.object({ messageId: z.string().min(3).max(998).optional() }).passthrough();

export async function dispatchIntegrationMail(
  db: Queryable,
  keyring: MasterKeyring,
  fetchImpl?: Fetch,
  now: Date = new Date(),
): Promise<{ sent: number; retry: number; failed: number }> {
  const tenantId = await currentTenantId(db);
  const { rows } = await db.query<{
    id: string;
    kind: string;
    integration_id: string;
    message_id: string | null;
    attempts: number;
    recipient_enc: Buffer;
    recipient_key_version: number;
    body_enc: Buffer;
    body_key_version: number;
  }>(
    `SELECT id, kind, integration_id, message_id, attempts, recipient_enc, recipient_key_version, body_enc,
            body_key_version
     FROM mail_outbox
     WHERE transport = 'integration' AND status = 'pending' AND coalesce(next_attempt_at, now()) <= $1
     ORDER BY created_at LIMIT 20`,
    [now],
  );
  const counts = { sent: 0, retry: 0, failed: 0 };
  for (const m of rows) {
    const to = openMail(keyring, tenantId, 'recipient', m.id, {
      ciphertext: m.recipient_enc,
      keyVersion: m.recipient_key_version,
    });
    const body = JSON.parse(
      openMail(keyring, tenantId, 'body', m.id, {
        ciphertext: m.body_enc,
        keyVersion: m.body_key_version,
      }),
    ) as {
      subject: string;
      text: string;
      html?: string;
      inReplyTo?: string;
      references?: string[];
    };
    const result = await postSigned(
      db,
      keyring,
      m.integration_id,
      {
        id: m.id,
        type: 'mail.send',
        occurredAt: now.toISOString(),
        data: {
          outboxId: m.id,
          kind: m.kind,
          messageId: m.message_id,
          to,
          subject: body.subject,
          text: body.text,
          html: body.html ?? null,
          inReplyTo: body.inReplyTo ?? null,
          references: body.references ?? [],
        },
      },
      fetchImpl,
      now,
    );
    const attempts = m.attempts + 1;
    if (!result.error) {
      const answer = answerSchema.safeParse(result.body ?? {});
      await db.query('SELECT mail_outbox_delivery($1, $2, $3, NULL, NULL)', [
        m.id,
        'sent',
        answer.success ? (answer.data.messageId ?? null) : null,
      ]);
      counts.sent += 1;
      continue;
    }
    const final = attempts >= MAX_ATTEMPTS || result.error === 'invalid_url';
    const delay = BACKOFF_SECONDS[Math.min(attempts, BACKOFF_SECONDS.length) - 1] ?? 60;
    await db.query('SELECT mail_outbox_delivery($1, $2, NULL, $3, $4)', [
      m.id,
      final ? 'failed' : 'pending',
      result.error,
      final ? null : new Date(now.getTime() + delay * 1000),
    ]);
    if (final) {
      await emitEvent(db, {
        eventType: 'mail.failed',
        aggregateType: 'mail_outbox',
        aggregateId: m.id,
        payload: { reason: result.error },
      });
      counts.failed += 1;
    } else counts.retry += 1;
  }
  if (rows.length) logEvent('mail.integration_dispatched', { tenantId, ...counts });
  return counts;
}
