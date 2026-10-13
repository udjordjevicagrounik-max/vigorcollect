import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  ConflictError,
  InvalidRequestError,
  NotFoundError,
  type TenantContext,
} from '@/server/auth/with-tenant';
import { getMasterKeyring, type MasterKeyring } from '@/server/crypto/keyring';
import { emitEvent } from '@/server/events';
import { seal } from './crypto';
import { OUTBOUND_EVENT_TYPES, ping, validateOutboundUrl, type Fetch } from './outbound';
import { newSecret } from './signing';

/**
 * Admin → Integrations (task 4.1). Reading: integration.read; changes: integration.manage.
 * Creating an integration returns its signing secret ONCE (UI only, never logged, stored
 * encrypted); n8n uses it to sign what it sends us and to verify what we send it.
 */

export const INTEGRATION_TYPES = ['mailbox', 'erp', 'risk', 'webhook'] as const;

const configSchema = z.object({
  outboundUrl: z.string().max(2000).optional(),
  events: z.array(z.enum(OUTBOUND_EVENT_TYPES)).max(OUTBOUND_EVENT_TYPES.length).default([]),
});

export const newIntegrationSchema = z.object({
  type: z.enum(INTEGRATION_TYPES),
  provider: z
    .string()
    .regex(/^[a-z][a-z0-9_]{1,30}$/)
    .default('n8n'),
  name: z.string().trim().min(1).max(120),
  outboundUrl: z.string().trim().max(2000).optional(),
  events: z.array(z.enum(OUTBOUND_EVENT_TYPES)).max(OUTBOUND_EVENT_TYPES.length).default([]),
});

export const updateIntegrationSchema = z.object({
  status: z.enum(['active', 'disabled']).optional(),
  outboundUrl: z.string().trim().max(2000).nullable().optional(),
  events: z.array(z.enum(OUTBOUND_EVENT_TYPES)).max(OUTBOUND_EVENT_TYPES.length).optional(),
});

export type IntegrationRow = {
  id: string;
  type: (typeof INTEGRATION_TYPES)[number];
  provider: string;
  name: string;
  status: 'active' | 'disabled';
  outboundUrl: string | null;
  events: string[];
  inboundPath: string;
  createdAt: string;
  pendingDeliveries: number;
  deadDeliveries: number;
  deadEvents: number;
};

export const inboundPath = (id: string) => `/api/integrations/${id}/inbound`;

export async function listIntegrations(ctx: TenantContext): Promise<IntegrationRow[]> {
  await ctx.requirePermission('integration.read');
  const { rows } = await ctx.db.query<{
    id: string;
    type: IntegrationRow['type'];
    provider: string;
    name: string;
    status: IntegrationRow['status'];
    config: unknown;
    created_at: Date;
    pending: number;
    dead: number;
    dead_events: number;
  }>(
    `SELECT i.id, i.type, i.provider, i.name, i.status, i.config, i.created_at,
            (SELECT count(*) FROM outbound_deliveries d WHERE d.integration_id = i.id AND d.status IN ('pending', 'failed'))::int AS pending,
            (SELECT count(*) FROM outbound_deliveries d WHERE d.integration_id = i.id AND d.status = 'dead')::int AS dead,
            (SELECT count(*) FROM webhook_events w WHERE w.integration_id = i.id AND w.status = 'dead')::int AS dead_events
     FROM integrations i ORDER BY i.status, i.created_at DESC`,
  );
  return rows.map((r) => {
    const cfg = configSchema.safeParse(r.config);
    return {
      id: r.id,
      type: r.type,
      provider: r.provider,
      name: r.name,
      status: r.status,
      outboundUrl: cfg.success ? (cfg.data.outboundUrl ?? null) : null,
      events: cfg.success ? cfg.data.events : [],
      inboundPath: inboundPath(r.id),
      createdAt: r.created_at.toISOString(),
      pendingDeliveries: r.pending,
      deadDeliveries: r.dead,
      deadEvents: r.dead_events,
    };
  });
}

export async function createIntegration(
  ctx: TenantContext,
  input: z.input<typeof newIntegrationSchema>,
  keyring: MasterKeyring = getMasterKeyring(),
): Promise<{ id: string; secret: string; inboundPath: string }> {
  await ctx.requirePermission('integration.manage');
  const data = newIntegrationSchema.parse(input);
  if (data.outboundUrl && !validateOutboundUrl(data.outboundUrl)) throw new InvalidRequestError();
  if (data.type === 'mailbox') {
    const active = await ctx.db.query(
      `SELECT 1 FROM integrations WHERE type = 'mailbox' AND status = 'active'`,
    );
    if (active.rowCount) throw new ConflictError('conflict');
  }
  const config = {
    ...(data.outboundUrl ? { outboundUrl: data.outboundUrl } : {}),
    events: data.events,
  };
  const { rows } = await ctx.db.query<{ id: string }>(
    `INSERT INTO integrations (tenant_id, type, provider, name, config, secret_ref, created_by, updated_by)
     VALUES (app_tenant_id(), $1, $2, $3, $4, 'signing', $5, $5) RETURNING id`,
    [data.type, data.provider, data.name, config, ctx.userId],
  );
  const id = rows[0]?.id ?? '';
  const secret = newSecret();
  const credId = randomUUID();
  const sealed = seal(keyring, ctx.tenantId, 'integration_credentials.secret', credId, secret);
  await ctx.db.query(
    `INSERT INTO integration_credentials (id, tenant_id, integration_id, purpose, secret_enc, secret_key_version, created_by)
     VALUES ($1, app_tenant_id(), $2, 'signing', $3, $4, $5)`,
    [credId, id, sealed.ciphertext, sealed.keyVersion, ctx.userId],
  );
  await ctx.audit({
    action: 'integration.created',
    entityType: 'integrations',
    entityId: id,
    after: { type: data.type, provider: data.provider, name: data.name, status: 'active', config },
  });
  await emitEvent(ctx.db, {
    eventType: 'integration.created',
    aggregateType: 'integrations',
    aggregateId: id,
    payload: { type: data.type, provider: data.provider },
    requestId: ctx.requestId,
    actorId: ctx.userId,
  });
  return { id, secret, inboundPath: inboundPath(id) };
}

export async function updateIntegration(
  ctx: TenantContext,
  id: string,
  input: z.input<typeof updateIntegrationSchema>,
): Promise<{ ok: true }> {
  await ctx.requirePermission('integration.manage');
  const data = updateIntegrationSchema.parse(input);
  if (data.outboundUrl && !validateOutboundUrl(data.outboundUrl)) throw new InvalidRequestError();
  const { rows } = await ctx.db.query<{ status: string; config: Record<string, unknown> }>(
    'SELECT status, config FROM integrations WHERE id = $1 FOR UPDATE',
    [id],
  );
  const cur = rows[0];
  if (!cur) throw new NotFoundError();
  const config: Record<string, unknown> = { ...cur.config };
  if (data.outboundUrl === null) delete config.outboundUrl;
  else if (data.outboundUrl !== undefined) config.outboundUrl = data.outboundUrl;
  if (data.events) config.events = data.events;
  await ctx.db.query(
    'UPDATE integrations SET status = coalesce($2, status), config = $3, updated_by = $4 WHERE id = $1',
    [id, data.status ?? null, config, ctx.userId],
  );
  await ctx.audit({
    action: 'integration.updated',
    entityType: 'integrations',
    entityId: id,
    before: { status: cur.status, config: cur.config },
    after: { status: data.status ?? cur.status, config },
  });
  return { ok: true };
}

export async function testPing(
  ctx: TenantContext,
  id: string,
  keyring: MasterKeyring = getMasterKeyring(),
  fetchImpl?: Fetch,
) {
  await ctx.requirePermission('integration.manage');
  const found = await ctx.db.query('SELECT 1 FROM integrations WHERE id = $1', [id]);
  if (!found.rowCount) throw new NotFoundError();
  const result = await ping(ctx.db, keyring, id, fetchImpl);
  await ctx.audit({
    action: 'integration.pinged',
    entityType: 'integrations',
    entityId: id,
    after: { status: result.status, http_status: result.httpStatus, error: result.error },
  });
  return result;
}

export type SyncRunRow = {
  id: string;
  provider: string;
  kind: string;
  status: string;
  counts: Record<string, number>;
  errorCode: string | null;
  startedAt: string;
};

export async function listSyncRuns(ctx: TenantContext, limit = 50): Promise<SyncRunRow[]> {
  await ctx.requirePermission('integration.read');
  const { rows } = await ctx.db.query<{
    id: string;
    provider: string;
    kind: string;
    status: string;
    counts: Record<string, number>;
    error_code: string | null;
    started_at: Date;
  }>(
    `SELECT id, provider, kind, status, counts, error_code, started_at FROM sync_runs
     ORDER BY started_at DESC LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({
    id: r.id,
    provider: r.provider,
    kind: r.kind,
    status: r.status,
    counts: r.counts,
    errorCode: r.error_code,
    startedAt: r.started_at.toISOString(),
  }));
}

export type DeadLetter = {
  kind: 'webhook' | 'delivery';
  id: string;
  integrationName: string;
  type: string;
  reason: string | null;
  attempts: number;
  at: string;
};

/** Dead letters of both directions (rule 95): visible, never deleted, retry possible. */
export async function listDeadLetters(ctx: TenantContext): Promise<DeadLetter[]> {
  await ctx.requirePermission('integration.read');
  const { rows } = await ctx.db.query<{
    kind: DeadLetter['kind'];
    id: string;
    name: string;
    type: string;
    reason: string | null;
    attempts: number;
    at: Date;
  }>(
    `SELECT 'webhook' AS kind, w.id, i.name, w.event_type AS type, w.dead_letter_reason AS reason, w.attempts,
            w.received_at AS at
     FROM webhook_events w JOIN integrations i ON i.id = w.integration_id WHERE w.status = 'dead'
     UNION ALL
     SELECT 'delivery', d.id, i.name, d.event_type, d.last_error, d.attempts, d.updated_at
     FROM outbound_deliveries d JOIN integrations i ON i.id = d.integration_id
     WHERE d.status = 'dead' AND d.event_id IS NOT NULL
     ORDER BY at DESC LIMIT 100`,
  );
  return rows.map((r) => ({
    kind: r.kind,
    id: r.id,
    integrationName: r.name,
    type: r.type,
    reason: r.reason,
    attempts: r.attempts,
    at: r.at.toISOString(),
  }));
}

export const retrySchema = z.object({ kind: z.enum(['webhook', 'delivery']) });

export async function retryDeadLetter(
  ctx: TenantContext,
  id: string,
  input: z.input<typeof retrySchema>,
): Promise<{ ok: true }> {
  await ctx.requirePermission('integration.manage');
  const { kind } = retrySchema.parse(input);
  if (kind === 'webhook') {
    const res = await ctx.db.query<{ integration_id: string; event_type: string }>(
      `UPDATE webhook_events SET status = 'received', attempts = 0, dead_letter_reason = NULL, updated_by = $2
       WHERE id = $1 AND status IN ('dead', 'failed') RETURNING integration_id, event_type`,
      [id, ctx.userId],
    );
    const r = res.rows[0];
    if (!r) throw new NotFoundError();
    await emitEvent(ctx.db, {
      eventType: 'webhook.received',
      aggregateType: 'webhook_events',
      aggregateId: id,
      payload: { integration_id: r.integration_id, type: r.event_type, retry: true },
      requestId: ctx.requestId,
      actorId: ctx.userId,
    });
  } else {
    const res = await ctx.db.query(
      `UPDATE outbound_deliveries SET status = 'pending', attempts = 0, next_attempt_at = now(), last_error = NULL
       WHERE id = $1 AND status IN ('dead', 'failed')`,
      [id],
    );
    if (!res.rowCount) throw new NotFoundError();
  }
  await ctx.audit({
    action: 'integration.retry_requested',
    entityType: kind === 'webhook' ? 'webhook_events' : 'outbound_deliveries',
    entityId: id,
  });
  return { ok: true };
}
