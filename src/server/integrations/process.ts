import { z } from 'zod';
import { logEvent } from '@/lib/log';
import type { AuditEntry } from '@/server/auth/audit';
import type { MasterKeyring } from '@/server/crypto/keyring';
import { currentTenantId, type Queryable } from '@/server/crypto/subject-keys';
import { emitEvent } from '@/server/events';
import { open } from './crypto';
import { envelopeSchema } from './inbound';

/**
 * Worker side of inbound webhooks (task 4.1): handler `webhook.received` → processWebhookEvent.
 * The payload is untrusted (rule 22): each event type has its own handler with its own Zod
 * schema; nothing in the content is ever interpreted as an instruction, and the handlers only
 * call the same services a person would. Outcome per event:
 *   - processed (handler succeeded) — a sync_runs row records the counters;
 *   - dead (invalid payload, unknown type, or 3 failed attempts) — visible in Admin →
 *     Integrations with "retry" (rule 95);
 *   - failed (< 3 attempts) — re-queued through a new domain event.
 */

export class PayloadError extends Error {
  override name = 'PayloadError';
}

export type WebhookContext = {
  db: Queryable;
  audit: (entry: AuditEntry) => Promise<void>;
  keyring: MasterKeyring;
  tenantId: string;
  integrationId: string;
  webhookEventId: string;
  receivedAt: Date;
};

export type WebhookHandler = (
  ctx: WebhookContext,
  data: Record<string, unknown>,
) => Promise<Record<string, number>>;

const handlers = new Map<string, WebhookHandler>([
  // Test ping from n8n: proves signature + delivery, does nothing.
  ['integration.ping', async () => ({ pings: 1 })],
]);

/** Event types register themselves (4.2 mail.received / mail.status). */
export function registerWebhookHandler(type: string, handler: WebhookHandler): void {
  handlers.set(type, handler);
}

export const MAX_WEBHOOK_ATTEMPTS = 3;

/** Parses with the handler's schema; a bad payload is dead at once (retrying cannot fix it). */
export function parsePayload<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new PayloadError('invalid payload');
  return parsed.data;
}

export async function processWebhookEvent(
  db: Queryable,
  audit: (entry: AuditEntry) => Promise<void>,
  keyring: MasterKeyring,
  webhookEventId: string,
): Promise<'processed' | 'failed' | 'dead' | 'skipped'> {
  const tenantId = await currentTenantId(db);
  const { rows } = await db.query<{
    integration_id: string;
    event_type: string;
    status: string;
    attempts: number;
    body_enc: Buffer;
    body_key_version: number;
    received_at: Date;
  }>(
    `SELECT integration_id, event_type, status, attempts, body_enc, body_key_version, received_at
     FROM webhook_events WHERE id = $1 FOR UPDATE`,
    [webhookEventId],
  );
  const ev = rows[0];
  if (!ev || ev.status === 'processed' || ev.status === 'dead') return 'skipped';

  const markDead = async (reason: string) => {
    await db.query(
      `UPDATE webhook_events SET status = 'dead', attempts = attempts + 1, dead_letter_reason = $2 WHERE id = $1`,
      [webhookEventId, reason],
    );
    await syncRun(db, ev.integration_id, ev.event_type, 'failed', {}, reason);
    logEvent('webhook.dead', { level: 'warn', tenantId, webhookEventId, reason });
    return 'dead' as const;
  };

  const handler = handlers.get(ev.event_type);
  if (!handler) return markDead('unknown_event_type');
  let data: Record<string, unknown>;
  try {
    const raw = open(keyring, tenantId, 'webhook_events.body', webhookEventId, {
      ciphertext: ev.body_enc,
      keyVersion: ev.body_key_version,
    });
    data = envelopeSchema.parse(JSON.parse(raw)).data;
  } catch {
    return markDead('invalid_payload');
  }

  await db.query('SAVEPOINT webhook_event');
  try {
    const counts = await handler(
      {
        db,
        audit,
        keyring,
        tenantId,
        integrationId: ev.integration_id,
        webhookEventId,
        receivedAt: ev.received_at,
      },
      data,
    );
    await db.query('RELEASE SAVEPOINT webhook_event');
    await db.query(
      `UPDATE webhook_events SET status = 'processed', processed_at = now(), attempts = attempts + 1 WHERE id = $1`,
      [webhookEventId],
    );
    await syncRun(db, ev.integration_id, ev.event_type, 'succeeded', counts, null);
    return 'processed';
  } catch (error) {
    await db.query('ROLLBACK TO SAVEPOINT webhook_event');
    if (error instanceof PayloadError) return markDead('invalid_payload');
    const attempts = ev.attempts + 1;
    if (attempts >= MAX_WEBHOOK_ATTEMPTS) return markDead('handler_failed');
    await db.query(`UPDATE webhook_events SET status = 'failed', attempts = $2 WHERE id = $1`, [
      webhookEventId,
      attempts,
    ]);
    await emitEvent(db, {
      eventType: 'webhook.received',
      aggregateType: 'webhook_events',
      aggregateId: webhookEventId,
      payload: { integration_id: ev.integration_id, type: ev.event_type, attempt: attempts + 1 },
    });
    logEvent('webhook.retry', {
      level: 'warn',
      tenantId,
      webhookEventId,
      attempts,
      name: error instanceof Error ? error.name : 'unknown',
    });
    return 'failed';
  }
}

async function syncRun(
  db: Queryable,
  integrationId: string,
  kind: string,
  status: 'succeeded' | 'failed',
  counts: Record<string, number>,
  error: string | null,
): Promise<void> {
  await db.query(
    `INSERT INTO sync_runs (tenant_id, integration_id, provider, kind, status, counts, error_code, finished_at)
     SELECT app_tenant_id(), i.id, i.provider, $2, $3, $4, $5, now() FROM integrations i WHERE i.id = $1`,
    [integrationId, `webhook.${kind}`.slice(0, 63), status, counts, error],
  );
}
