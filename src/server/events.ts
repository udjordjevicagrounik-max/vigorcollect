import type { Queryable } from '@/server/crypto/subject-keys';

/**
 * Appends a domain event in the CURRENT tenant transaction (outbox, ADR 0005): written together
 * with the change it describes, processed later by the worker. Payload: ids and P0 values only
 * (pii_field_registry: domain_events.payload is a container for ids / P0 / ciphertext).
 */
export async function emitEvent(
  db: Queryable,
  event: {
    eventType: string;
    aggregateType: string;
    aggregateId: string | null;
    payload?: Record<string, unknown>;
    requestId?: string | null;
    actorId?: string | null;
  },
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO domain_events (tenant_id, event_type, aggregate_type, aggregate_id, payload,
                                request_id, created_by)
     VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6) RETURNING id`,
    [
      event.eventType,
      event.aggregateType,
      event.aggregateId,
      event.payload ?? {},
      event.requestId ?? null,
      event.actorId ?? null,
    ],
  );
  return rows[0]?.id ?? '';
}
