import { z } from 'zod';
import { logEvent } from '@/lib/log';
import type { MasterKeyring } from '@/server/crypto/keyring';
import { currentTenantId } from '@/server/crypto/subject-keys';
import { emitEvent } from '@/server/events';
import {
  BACKOFF_SECONDS,
  CLAIM_LEASE_SECONDS,
  MAX_ATTEMPTS,
  sendSigned,
  signedTarget,
  type Fetch,
  type SendResult,
} from '@/server/integrations/outbound';
import type { TenantTx } from '@/server/jobs/tenant-job';
import { openMail } from './crypto';

/**
 * Collection mail through the tenant's mailbox integration (task 4.2), in the worker, per tenant.
 * Each due row is decrypted here only, signed and POSTed to n8n as `mail.send`; n8n answers 2xx
 * AFTER sending, with the provider's Message-ID. Status goes through mail_outbox_delivery() (the
 * app role cannot UPDATE mail_outbox): sent, or one more attempt with backoff, or failed after
 * the last one. A demo tenant never has integration rows (the adapter picks the sink; the
 * database trigger refuses anything else, rule 24).
 *
 * Exactly-once toward the customer (review S-09), per mail:
 *   1. claim (mail_outbox_claim: next_attempt_at → end of the lease) + decrypt — COMMITTED;
 *   2. POST outside any transaction, Idempotency-Key = mail_outbox.id (n8n drops a repeat);
 *   3. record the result — its own transaction.
 * An error in one mail never undoes another mail's "sent"; a crash between 2 and 3 retries the
 * mail only after the lease, with the same key. A row that cannot be decrypted is failed at
 * once (never retried forever).
 */

const answerSchema = z.object({ messageId: z.string().min(3).max(998).optional() }).passthrough();

type Claimed = {
  kind: string;
  integration_id: string;
  message_id: string | null;
  attempts: number;
  recipient_enc: Buffer;
  recipient_key_version: number;
  body_enc: Buffer;
  body_key_version: number;
};

type MailBody = {
  subject: string;
  text: string;
  html?: string;
  inReplyTo?: string;
  references?: string[];
};

export async function dispatchIntegrationMail(
  run: TenantTx,
  keyring: MasterKeyring,
  fetchImpl?: Fetch,
  now: Date = new Date(),
): Promise<{ sent: number; retry: number; failed: number }> {
  const leaseUntil = new Date(now.getTime() + CLAIM_LEASE_SECONDS * 1000);
  const { tenantId, ids } = await run(async (db) => {
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM mail_outbox
       WHERE transport = 'integration' AND status = 'pending' AND coalesce(next_attempt_at, $1) <= $1
       ORDER BY created_at LIMIT 20`,
      [now],
    );
    return { tenantId: await currentTenantId(db), ids: rows.map((r) => r.id) };
  });
  const counts = { sent: 0, retry: 0, failed: 0 };
  for (const id of ids) {
    try {
      const claimed = await run(async (db) => {
        const ok = await db.query<{ ok: boolean }>('SELECT mail_outbox_claim($1, $2, $3) AS ok', [
          id,
          now,
          leaseUntil,
        ]);
        if (!ok.rows[0]?.ok) return null;
        const { rows } = await db.query<Claimed>(
          `SELECT kind, integration_id, message_id, attempts, recipient_enc, recipient_key_version, body_enc,
                  body_key_version
           FROM mail_outbox WHERE id = $1`,
          [id],
        );
        const m = rows[0];
        if (!m) return null;
        let to: string;
        let body: MailBody;
        try {
          to = openMail(keyring, tenantId, 'recipient', id, {
            ciphertext: m.recipient_enc,
            keyVersion: m.recipient_key_version,
          });
          body = JSON.parse(
            openMail(keyring, tenantId, 'body', id, {
              ciphertext: m.body_enc,
              keyVersion: m.body_key_version,
            }),
          ) as MailBody;
        } catch {
          await db.query('SELECT mail_outbox_delivery($1, $2, NULL, $3, NULL)', [
            id,
            'failed',
            'dispatch.unreadable',
          ]);
          await emitEvent(db, {
            eventType: 'mail.failed',
            aggregateType: 'mail_outbox',
            aggregateId: id,
            payload: { reason: 'dispatch.unreadable' },
          });
          return 'unreadable' as const;
        }
        return { m, to, body, target: await signedTarget(db, keyring, m.integration_id) };
      });
      if (!claimed) continue;
      if (claimed === 'unreadable') {
        counts.failed += 1;
        continue;
      }

      const { m, to, body, target } = claimed;
      const result: SendResult = await sendSigned(
        target,
        {
          id,
          type: 'mail.send',
          occurredAt: now.toISOString(),
          data: {
            outboxId: id,
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
        id,
        fetchImpl,
        now,
      );

      const outcome = await run(async (db) => {
        if (!result.error) {
          const answer = answerSchema.safeParse(result.body ?? {});
          await db.query('SELECT mail_outbox_delivery($1, $2, $3, NULL, NULL)', [
            id,
            'sent',
            answer.success ? (answer.data.messageId ?? null) : null,
          ]);
          return 'sent' as const;
        }
        const attempts = m.attempts + 1;
        const final = attempts >= MAX_ATTEMPTS || result.error === 'invalid_url';
        const delay = BACKOFF_SECONDS[Math.min(attempts, BACKOFF_SECONDS.length) - 1] ?? 60;
        await db.query('SELECT mail_outbox_delivery($1, $2, NULL, $3, $4)', [
          id,
          final ? 'failed' : 'pending',
          result.error,
          final ? null : new Date(now.getTime() + delay * 1000),
        ]);
        if (final) {
          await emitEvent(db, {
            eventType: 'mail.failed',
            aggregateType: 'mail_outbox',
            aggregateId: id,
            payload: { reason: result.error },
          });
        }
        return final ? ('failed' as const) : ('retry' as const);
      });
      counts[outcome] += 1;
    } catch (error) {
      // This mail stays claimed until the lease ends; the others go on.
      logEvent('mail.dispatch_error', {
        level: 'error',
        tenantId,
        outboxId: id,
        name: error instanceof Error ? error.name : 'unknown',
      });
    }
  }
  if (ids.length) logEvent('mail.integration_dispatched', { tenantId, ...counts });
  return counts;
}
