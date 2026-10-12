import type { Pool, PoolClient } from 'pg';
import { logEvent } from '@/lib/log';
import { reportError } from '@/server/observability/sentry';
import { withTenantJob, type TenantJobContext } from './tenant-job';

/**
 * Outbox (ADR 0002 "Otvoreno" 2). The worker role reads domain_events of all tenants and only
 * advances their status; the work itself runs per event in withTenantJob(event.tenant_id) as
 * vigor_app. Idempotency key = event id: the pg-boss job id IS the event id (a second enqueue is
 * ignored) and a processed event is never handled again. Failures retry 3× with backoff
 * (pg-boss); after the last one the event is 'failed' with an error code — visible, never
 * deleted (rule 95).
 */

export const EVENT_QUEUE = 'domain-event';
export const EVENT_RETRY_LIMIT = 3;

export type DomainEvent = {
  id: string;
  tenantId: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string | null;
  payload: Record<string, unknown>;
};

export type EventHandler = (ctx: TenantJobContext, event: DomainEvent) => Promise<void>;
export type EventHandlers = Readonly<Record<string, EventHandler>>;

export type Enqueue = (
  client: PoolClient,
  event: { id: string; tenantId: string },
) => Promise<void>;

/** pending → processing for up to `limit` events and enqueue them in the SAME transaction. */
export async function dispatchPending(
  workerPool: Pool,
  enqueue: Enqueue,
  limit = 100,
): Promise<number> {
  const client = await workerPool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ id: string; tenant_id: string }>(
      `UPDATE domain_events SET status = 'processing'
       WHERE id IN (SELECT id FROM domain_events WHERE status = 'pending'
                    ORDER BY occurred_at, id LIMIT $1 FOR UPDATE SKIP LOCKED)
       RETURNING id, tenant_id`,
      [limit],
    );
    for (const r of rows) await enqueue(client, { id: r.id, tenantId: r.tenant_id });
    await client.query('COMMIT');
    if (rows.length) logEvent('outbox.dispatched', { count: rows.length });
    return rows.length;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

type EventRow = {
  id: string;
  tenant_id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string | null;
  payload: Record<string, unknown>;
  status: string;
};

export type ProcessResult = 'processed' | 'skipped' | 'no_handler';

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(code)) return code;
  return error instanceof Error ? error.name.slice(0, 64) : 'unknown';
}

/**
 * Handles one event. `attempt` comes from pg-boss (retryCount of this run, retryLimit of the
 * job). Throws on failure so pg-boss retries — and marks the event 'failed' on the last attempt.
 */
export async function processEvent(
  deps: { workerPool: Pool; appPool: Pool; handlers: EventHandlers },
  eventId: string,
  attempt: { retryCount: number; retryLimit: number },
): Promise<ProcessResult> {
  const { rows } = await deps.workerPool.query<EventRow>(
    `SELECT id, tenant_id, event_type, aggregate_type, aggregate_id, payload, status
     FROM domain_events WHERE id = $1`,
    [eventId],
  );
  const row = rows[0];
  if (!row || row.status !== 'processing') return 'skipped';

  const handler = deps.handlers[row.event_type];
  const event: DomainEvent = {
    id: row.id,
    tenantId: row.tenant_id,
    eventType: row.event_type,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    payload: row.payload,
  };
  try {
    if (handler)
      await withTenantJob(deps.appPool, row.tenant_id, row.id, (ctx) => handler(ctx, event));
  } catch (error) {
    const final = attempt.retryCount >= attempt.retryLimit;
    const code = errorCode(error);
    await deps.workerPool.query(
      `UPDATE domain_events SET attempts = attempts + 1, last_error = $2,
              status = CASE WHEN $3 THEN 'failed' ELSE 'processing' END
       WHERE id = $1 AND status = 'processing'`,
      [row.id, code, final],
    );
    if (final) {
      reportError(error, {
        event_id: row.id,
        tenant_id: row.tenant_id,
        event_type: row.event_type,
      });
    }
    logEvent(final ? 'outbox.failed' : 'outbox.retry', {
      level: final ? 'error' : 'warn',
      eventId: row.id,
      tenantId: row.tenant_id,
      eventType: row.event_type,
      code,
      attempt: attempt.retryCount + 1,
    });
    throw error;
  }
  await deps.workerPool.query(
    `UPDATE domain_events SET status = 'processed', processed_at = now(), last_error = NULL
     WHERE id = $1 AND status = 'processing'`,
    [row.id],
  );
  if (!handler) {
    logEvent('outbox.no_handler', { eventId: row.id, eventType: row.event_type });
    return 'no_handler';
  }
  return 'processed';
}
