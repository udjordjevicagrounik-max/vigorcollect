import type { Queryable } from '@/server/crypto/subject-keys';

/**
 * audit() — the single writer of audit_log rows (rule 6, task 1.2). Snapshots are redacted
 * through pii_field_registry before they are stored: a value survives only when its column of
 * `entityType` is registered as P0 without a condition. Anything else — P1–P3, conditionally
 * personal, or not registered at all — becomes "[redacted]" (unknown = unsafe). Callers key
 * `before` / `after` by the entity table's column names.
 */

export const REDACTED = '[redacted]';

export type AuditActor =
  | { type: 'user'; id: string }
  // 4.1: an integration calling the API with a tenant API key (id = api_keys.id).
  | { type: 'api_key'; id: string }
  | { type: 'system' | 'job' | 'ai'; id?: string | null };

export type AuditEntry = {
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
};

type RegistryRow = { column_name: string; pii_class: string; conditional_on: string | null };

async function safeColumns(db: Queryable, table: string): Promise<Set<string>> {
  const { rows } = await db.query<RegistryRow>(
    'SELECT column_name, pii_class, conditional_on FROM pii_field_registry WHERE table_name = $1',
    [table],
  );
  return new Set(
    rows.filter((r) => r.pii_class === 'P0' && r.conditional_on === null).map((r) => r.column_name),
  );
}

export function redact(
  snapshot: Record<string, unknown> | null | undefined,
  safe: Set<string>,
): Record<string, unknown> | null {
  if (!snapshot) return null;
  return Object.fromEntries(
    Object.entries(snapshot).map(([key, value]) => [key, safe.has(key) ? value : REDACTED]),
  );
}

/** Writes one audit row in the CURRENT tenant transaction (tenant_id = app_tenant_id()). */
export async function writeAudit(
  db: Queryable,
  actor: AuditActor,
  entry: AuditEntry,
  requestId: string | null,
): Promise<void> {
  const safe = await safeColumns(db, entry.entityType);
  await db.query(
    `INSERT INTO audit_log (tenant_id, actor_type, actor_id, action, entity_type, entity_id,
                            before, after, request_id, created_by)
     VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $2)`,
    [
      actor.type,
      actor.id ?? null,
      entry.action,
      entry.entityType,
      entry.entityId ?? null,
      redact(entry.before, safe),
      redact(entry.after, safe),
      requestId,
    ],
  );
}
