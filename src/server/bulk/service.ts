import { z } from 'zod';
import { PermissionDeniedError } from '@/server/auth/permissions';
import { scopeFilter } from '@/server/auth/scope';
import {
  ConflictError,
  createTenantContext,
  NotFoundError,
  type TenantContext,
} from '@/server/auth/with-tenant';
import { createCase } from '@/server/collections/service';
import { getMasterKeyring, type MasterKeyring } from '@/server/crypto/keyring';
import { emitEvent } from '@/server/events';
import type { TenantJobContext } from '@/server/jobs/tenant-job';
import { sendMessage } from '@/server/mail/communication';

/**
 * Bulk actions on the customer and invoice lists (5.1). Flow: selection → preview (count + first
 * 10, only what is in the member's scope) → confirmation → ONE bulk_runs row + one bulk_run_items
 * row per item → domain event bulk.requested → the worker runs every item AS THE REQUESTER
 * (their permissions and scope are checked again per item) → report (ok / failed / skipped per
 * item). Limit per run: tenant_settings.bulk_max_items (default 500). Audit: every item writes
 * its own entry through the action it runs, the run writes bulk_run.requested / .completed.
 *
 * Never in bulk (rules 11/19): templates with legal effect (dunning letters), the legal stage,
 * legal handover, write-offs, settlements — they need a decision per item. Customer-level
 * actions on an invoice selection act once per customer (the other invoices of that customer
 * share the outcome).
 */

export const BULK_ACTIONS = [
  'assign_owner',
  'assign_team',
  'change_policy',
  'send_reminder',
  'open_case',
  'export',
] as const;
export type BulkAction = (typeof BULK_ACTIONS)[number];
export const BULK_ENTITIES = ['customers', 'invoices'] as const;
export type BulkEntity = (typeof BULK_ENTITIES)[number];

const code = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);
export const bulkSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('assign_owner'), params: z.object({ userId: z.uuid() }) }),
  z.object({ action: z.literal('assign_team'), params: z.object({ teamId: z.uuid() }) }),
  z.object({ action: z.literal('change_policy'), params: z.object({ policyCode: code }) }),
  z.object({ action: z.literal('send_reminder'), params: z.object({ templateKey: code }) }),
  z.object({ action: z.literal('open_case'), params: z.object({}).default({}) }),
  z.object({ action: z.literal('export'), params: z.object({ format: z.enum(['csv']) }) }),
]);
export const bulkRequestSchema = z.object({
  entity: z.enum(BULK_ENTITIES),
  ids: z.array(z.uuid()).min(1).max(5000),
  bulk: bulkSchema,
});
export type BulkRequest = z.input<typeof bulkRequestSchema>;

const PERMISSION: Record<BulkAction, (entity: BulkEntity) => string> = {
  assign_owner: () => 'customer.assign',
  assign_team: () => 'customer.assign',
  change_policy: () => 'customer.update',
  send_reminder: () => 'activity.create',
  open_case: () => 'case.create',
  export: (entity) => (entity === 'customers' ? 'customer.export' : 'invoice.export'),
};

export const PREVIEW_SIZE = 10;

type Target = { id: string; customerId: string; label: string | null };

/** The selected ids that the member may see, in list order (scope through the customer). */
async function inScope(
  ctx: TenantContext,
  entity: BulkEntity,
  ids: string[],
  permission: string,
): Promise<Target[]> {
  const { scope } = await ctx.requirePermission(permission);
  const f = scopeFilter('customers', { userId: ctx.userId, scope }, 'c', 2);
  const unique = [...new Set(ids)];
  const { rows } =
    entity === 'customers'
      ? await ctx.db.query<{ id: string; customer_id: string; label: string | null }>(
          `SELECT c.id, c.id AS customer_id, c.display_name AS label FROM customers c
           WHERE c.id = ANY($1::uuid[]) AND ${f.sql}
           ORDER BY c.display_name NULLS LAST, c.id`,
          [unique, ...f.params],
        )
      : await ctx.db.query<{ id: string; customer_id: string; label: string | null }>(
          `SELECT i.id, c.id AS customer_id, i.number AS label
           FROM invoices i JOIN customers c ON c.id = i.customer_id
           WHERE i.id = ANY($1::uuid[]) AND ${f.sql}
           ORDER BY i.due_date, i.number, i.id`,
          [unique, ...f.params],
        );
  return rows.map((r) => ({ id: r.id, customerId: r.customer_id, label: r.label }));
}

async function bulkLimit(ctx: Pick<TenantContext, 'db'>): Promise<number> {
  const { rows } = await ctx.db.query<{ n: number }>(
    'SELECT coalesce((SELECT bulk_max_items FROM tenant_settings), 500) AS n',
  );
  return rows[0]?.n ?? 500;
}

/** Parameters must name something that exists and is allowed in bulk (rules 11/19). */
async function checkParams(ctx: TenantContext, bulk: z.infer<typeof bulkSchema>): Promise<void> {
  const one = async (sql: string, params: unknown[]) => {
    const { rowCount } = await ctx.db.query(sql, params);
    if (!rowCount) throw new ConflictError('invalid_request');
  };
  switch (bulk.action) {
    case 'assign_owner':
      return one(`SELECT 1 FROM users WHERE id = $1 AND status = 'active'`, [bulk.params.userId]);
    case 'assign_team':
      return one(`SELECT 1 FROM teams WHERE id = $1 AND status = 'active'`, [bulk.params.teamId]);
    case 'change_policy':
      return one(
        `SELECT 1 FROM code_lists WHERE list_key = 'collection_policy' AND code = $1 AND is_active`,
        [bulk.params.policyCode],
      );
    case 'send_reminder': {
      const { rows } = await ctx.db.query<{ legal: boolean }>(
        `SELECT has_legal_effect AS legal FROM templates
         WHERE key = $1 AND channel = 'email' AND status = 'active'`,
        [bulk.params.templateKey],
      );
      if (!rows[0]) throw new ConflictError('invalid_request');
      if (rows[0].legal) throw new ConflictError('not_bulk');
      return;
    }
    default:
      return;
  }
}

export type BulkPreview = {
  count: number;
  /** Selected ids the member cannot see (or that do not exist): never processed. */
  skipped: number;
  limit: number;
  sample: { id: string; label: string | null }[];
};

export async function previewBulk(ctx: TenantContext, input: BulkRequest): Promise<BulkPreview> {
  const data = bulkRequestSchema.parse(input);
  const targets = await inScope(
    ctx,
    data.entity,
    data.ids,
    PERMISSION[data.bulk.action](data.entity),
  );
  await checkParams(ctx, data.bulk);
  return {
    count: targets.length,
    skipped: new Set(data.ids).size - targets.length,
    limit: await bulkLimit(ctx),
    sample: targets.slice(0, PREVIEW_SIZE).map((t) => ({ id: t.id, label: t.label })),
  };
}

export async function startBulk(ctx: TenantContext, input: BulkRequest): Promise<{ id: string }> {
  const data = bulkRequestSchema.parse(input);
  // A run executes as its requester in the worker — a person, never an API key.
  if (ctx.actorType === 'api_key') throw new PermissionDeniedError();
  const targets = await inScope(
    ctx,
    data.entity,
    data.ids,
    PERMISSION[data.bulk.action](data.entity),
  );
  await checkParams(ctx, data.bulk);
  if (targets.length === 0) throw new NotFoundError();
  if (targets.length > (await bulkLimit(ctx))) throw new ConflictError('limit_exceeded');
  const { rows } = await ctx.db.query<{ id: string }>(
    `INSERT INTO bulk_runs (tenant_id, entity_type, action, params, item_count, requested_by, request_id)
     VALUES (app_tenant_id(), $1, $2, $3::jsonb, $4, $5, $6) RETURNING id`,
    [
      data.entity,
      data.bulk.action,
      JSON.stringify(data.bulk.params),
      targets.length,
      ctx.userId,
      ctx.requestId,
    ],
  );
  const id = rows[0]?.id ?? '';
  await ctx.db.query(
    `INSERT INTO bulk_run_items (tenant_id, run_id, entity_id)
     SELECT app_tenant_id(), $1, unnest($2::uuid[])`,
    [id, targets.map((t) => t.id)],
  );
  await ctx.audit({
    action: 'bulk_run.requested',
    entityType: 'bulk_runs',
    entityId: id,
    after: { entity: data.entity, action: data.bulk.action, items: targets.length },
  });
  await emitEvent(ctx.db, {
    eventType: 'bulk.requested',
    aggregateType: 'bulk_runs',
    aggregateId: id,
    payload: { action: data.bulk.action, items: targets.length },
    requestId: ctx.requestId,
    actorId: ctx.userId,
  });
  return { id };
}

// ---------------------------------------------------------------------------------------------
// Worker side
// ---------------------------------------------------------------------------------------------

type Outcome = { status: 'ok' | 'failed' | 'skipped'; error?: string };

function failure(error: unknown): Outcome {
  if (error instanceof NotFoundError) return { status: 'failed', error: 'not_found' };
  if (error instanceof PermissionDeniedError) return { status: 'failed', error: 'forbidden' };
  if (error instanceof ConflictError) return { status: 'failed', error: error.code };
  return { status: 'failed', error: 'internal' };
}

/** One customer-level step, in the requester's context. */
async function runForCustomer(
  ctx: TenantContext,
  bulk: z.infer<typeof bulkSchema>,
  runId: string,
  customerId: string,
  invoiceIds: string[] | null,
  keyring: MasterKeyring,
): Promise<Outcome> {
  const scoped = async (permission: string) => {
    const { scope } = await ctx.requirePermission(permission);
    const f = scopeFilter('customers', { userId: ctx.userId, scope }, 'c', 2);
    const { rows } = await ctx.db.query<{
      owner_user_id: string | null;
      owner_team_id: string | null;
      policy_code: string | null;
    }>(
      `SELECT c.owner_user_id, c.owner_team_id, c.policy_code FROM customers c
       WHERE c.id = $1 AND ${f.sql} FOR UPDATE`,
      [customerId, ...f.params],
    );
    if (!rows[0]) throw new NotFoundError();
    return rows[0];
  };
  const change = async (
    column: 'owner_user_id' | 'owner_team_id' | 'policy_code',
    value: string,
  ) => {
    const before = await scoped(PERMISSION[bulk.action]('customers'));
    if (before[column] === value) return { status: 'skipped', error: 'unchanged' } as Outcome;
    // column is one of three fixed names (never input).
    const sql = {
      owner_user_id: 'UPDATE customers SET owner_user_id = $2, updated_by = $3 WHERE id = $1',
      owner_team_id: 'UPDATE customers SET owner_team_id = $2, updated_by = $3 WHERE id = $1',
      policy_code: 'UPDATE customers SET policy_code = $2, updated_by = $3 WHERE id = $1',
    }[column];
    await ctx.db.query(sql, [customerId, value, ctx.userId]);
    await ctx.audit({
      action: `customer.${bulk.action}`,
      entityType: 'customers',
      entityId: customerId,
      before: { [column]: before[column] },
      after: { [column]: value, bulk_run_id: runId },
    });
    return { status: 'ok' } as Outcome;
  };

  switch (bulk.action) {
    case 'assign_owner':
      return change('owner_user_id', bulk.params.userId);
    case 'assign_team':
      return change('owner_team_id', bulk.params.teamId);
    case 'change_policy':
      return change('policy_code', bulk.params.policyCode);
    case 'send_reminder': {
      await scoped('activity.create');
      // A disputed invoice gets no reminder (5.1): skip when nothing undisputed is overdue.
      const { rows } = await ctx.db.query<{ undisputed: boolean }>(
        `SELECT coalesce(bool_or(NOT p.is_disputed), false) AS undisputed FROM invoice_positions p
         WHERE p.customer_id = $1 AND p.is_overdue AND ($2::uuid[] IS NULL OR p.invoice_id = ANY($2::uuid[]))`,
        [customerId, invoiceIds],
      );
      if (!rows[0]?.undisputed) return { status: 'skipped', error: 'disputed_or_not_overdue' };
      await sendMessage(ctx, customerId, { templateKey: bulk.params.templateKey }, keyring);
      return { status: 'ok' };
    }
    case 'open_case': {
      await scoped('case.create');
      const open = await ctx.db.query(
        `SELECT 1 FROM collection_cases WHERE customer_id = $1 AND status = 'open'`,
        [customerId],
      );
      if (open.rowCount) return { status: 'skipped', error: 'case_exists' };
      const { rows } = await ctx.db.query<{ id: string }>(
        `SELECT p.invoice_id AS id FROM invoice_positions p
         WHERE p.customer_id = $1 AND p.is_overdue
           AND ($2::uuid[] IS NULL OR p.invoice_id = ANY($2::uuid[]))
         ORDER BY p.invoice_id LIMIT 200`,
        [customerId, invoiceIds],
      );
      if (!rows.length) return { status: 'skipped', error: 'not_overdue' };
      await createCase(ctx, { customerId, invoiceIds: rows.map((r) => r.id) });
      return { status: 'ok' };
    }
    case 'export':
      // The export run is handled as a whole (runBulkExport), never per customer.
      return { status: 'skipped', error: 'unsupported' };
  }
}

export type BulkExportHook = (
  ctx: TenantContext,
  run: { id: string; entity: BulkEntity; ids: string[] },
) => Promise<{ resultRef: string; rows: number }>;

/**
 * Worker handler of bulk.requested. Idempotent: a finished run is left alone; pending items of a
 * run that died half-way continue. Every item runs in a SAVEPOINT — one failure never undoes the
 * others.
 */
export async function runBulk(
  job: TenantJobContext,
  runId: string,
  options: { keyring?: MasterKeyring; exportHook?: BulkExportHook } = {},
): Promise<{ ok: number; failed: number; skipped: number } | null> {
  const keyring = options.keyring ?? getMasterKeyring();
  const { rows } = await job.db.query<{
    entity_type: BulkEntity;
    action: BulkAction;
    params: Record<string, unknown>;
    status: string;
    requested_by: string;
    request_id: string | null;
    active: boolean;
  }>(
    `SELECT r.entity_type, r.action, r.params, r.status, r.requested_by, r.request_id,
            (u.status = 'active') AS active
     FROM bulk_runs r JOIN users u ON u.id = r.requested_by WHERE r.id = $1 FOR UPDATE OF r`,
    [runId],
  );
  const run = rows[0];
  if (!run || run.status === 'completed' || run.status === 'failed') return null;
  await job.db.query(
    `UPDATE bulk_runs SET status = 'running', started_at = coalesce(started_at, now()) WHERE id = $1`,
    [runId],
  );
  const ctx = createTenantContext(job.db, {
    tenantId: job.tenantId,
    userId: run.requested_by,
    authUserId: 'job:bulk',
    requestId: run.request_id ?? job.jobId,
  });
  const bulk = bulkSchema.parse({ action: run.action, params: run.params });
  const items = await job.db.query<{ entity_id: string; customer_id: string | null }>(
    run.entity_type === 'customers'
      ? `SELECT b.entity_id, b.entity_id AS customer_id FROM bulk_run_items b
         WHERE b.run_id = $1 AND b.status = 'pending' ORDER BY b.entity_id`
      : `SELECT b.entity_id, i.customer_id FROM bulk_run_items b
         LEFT JOIN invoices i ON i.id = b.entity_id
         WHERE b.run_id = $1 AND b.status = 'pending' ORDER BY i.customer_id, b.entity_id`,
    [runId],
  );
  const mark = (ids: string[], o: Outcome) =>
    job.db.query(
      `UPDATE bulk_run_items SET status = $3, error_code = $4, processed_at = now()
       WHERE run_id = $1 AND entity_id = ANY($2::uuid[])`,
      [runId, ids, o.status, o.error ?? null],
    );

  if (!run.active) {
    await mark(
      items.rows.map((r) => r.entity_id),
      { status: 'failed', error: 'requester_inactive' },
    );
  } else if (bulk.action === 'export') {
    const ids = items.rows.map((r) => r.entity_id);
    try {
      if (!options.exportHook) throw new ConflictError('unsupported');
      await job.db.query('SAVEPOINT bulk_item');
      const out = await options.exportHook(ctx, { id: runId, entity: run.entity_type, ids });
      await job.db.query('RELEASE SAVEPOINT bulk_item');
      await job.db.query('UPDATE bulk_runs SET result_ref = $2 WHERE id = $1', [
        runId,
        out.resultRef,
      ]);
      await mark(ids, { status: 'ok' });
    } catch (error) {
      await job.db.query('ROLLBACK TO SAVEPOINT bulk_item').catch(() => undefined);
      await mark(ids, failure(error));
    }
  } else {
    // Group by customer: a customer-level action runs once per customer.
    const groups = new Map<string, string[]>();
    const orphans: string[] = [];
    for (const r of items.rows) {
      if (!r.customer_id) orphans.push(r.entity_id);
      else groups.set(r.customer_id, [...(groups.get(r.customer_id) ?? []), r.entity_id]);
    }
    if (orphans.length) await mark(orphans, { status: 'failed', error: 'not_found' });
    for (const [customerId, ids] of groups) {
      await job.db.query('SAVEPOINT bulk_item');
      let outcome: Outcome;
      try {
        outcome = await runForCustomer(
          ctx,
          bulk,
          runId,
          customerId,
          run.entity_type === 'invoices' ? ids : null,
          keyring,
        );
        await job.db.query('RELEASE SAVEPOINT bulk_item');
      } catch (error) {
        await job.db.query('ROLLBACK TO SAVEPOINT bulk_item');
        outcome = failure(error);
      }
      await mark(ids, outcome);
    }
  }

  const { rows: totals } = await job.db.query<{ ok: number; failed: number; skipped: number }>(
    `SELECT count(*) FILTER (WHERE status = 'ok')::int AS ok,
            count(*) FILTER (WHERE status = 'failed')::int AS failed,
            count(*) FILTER (WHERE status = 'skipped')::int AS skipped
     FROM bulk_run_items WHERE run_id = $1`,
    [runId],
  );
  const t = totals[0] ?? { ok: 0, failed: 0, skipped: 0 };
  await job.db.query(
    `UPDATE bulk_runs SET status = 'completed', ok_count = $2, failed_count = $3, finished_at = now()
     WHERE id = $1`,
    [runId, t.ok, t.failed],
  );
  await ctx.audit({
    action: 'bulk_run.completed',
    entityType: 'bulk_runs',
    entityId: runId,
    after: { action: run.action, ok: t.ok, failed: t.failed, skipped: t.skipped },
  });
  return t;
}

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------

export type BulkReport = {
  id: string;
  entity: BulkEntity;
  action: BulkAction;
  status: string;
  itemCount: number;
  okCount: number;
  failedCount: number;
  hasFile: boolean;
  createdAt: string;
  finishedAt: string | null;
  items: { id: string; label: string | null; status: string; error: string | null }[];
};

/** The requester sees their run; anyone else needs the same permission at ORGANIZATION scope. */
export async function getBulkReport(ctx: TenantContext, runId: string): Promise<BulkReport> {
  const { rows } = await ctx.db.query<{
    entity_type: BulkEntity;
    action: BulkAction;
    status: string;
    item_count: number;
    ok_count: number;
    failed_count: number;
    result_ref: string | null;
    requested_by: string;
    created_at: Date;
    finished_at: Date | null;
  }>(
    `SELECT entity_type, action, status, item_count, ok_count, failed_count, result_ref,
            requested_by, created_at, finished_at FROM bulk_runs WHERE id = $1`,
    [runId],
  );
  const r = rows[0];
  if (!r) throw new NotFoundError();
  if (r.requested_by !== ctx.userId) {
    const grant = await ctx.requirePermission(PERMISSION[r.action](r.entity_type));
    if (grant.scope !== 'ORGANIZATION') throw new NotFoundError();
  }
  const items = await ctx.db.query<{
    id: string;
    label: string | null;
    status: string;
    error_code: string | null;
  }>(
    r.entity_type === 'customers'
      ? `SELECT b.entity_id AS id, c.display_name AS label, b.status, b.error_code
         FROM bulk_run_items b LEFT JOIN customers c ON c.id = b.entity_id
         WHERE b.run_id = $1 ORDER BY (b.status = 'failed') DESC, c.display_name NULLS LAST, b.entity_id`
      : `SELECT b.entity_id AS id, i.number AS label, b.status, b.error_code
         FROM bulk_run_items b LEFT JOIN invoices i ON i.id = b.entity_id
         WHERE b.run_id = $1 ORDER BY (b.status = 'failed') DESC, i.number, b.entity_id`,
    [runId],
  );
  return {
    id: runId,
    entity: r.entity_type,
    action: r.action,
    status: r.status,
    itemCount: r.item_count,
    okCount: r.ok_count,
    failedCount: r.failed_count,
    hasFile: r.result_ref !== null,
    createdAt: r.created_at.toISOString(),
    finishedAt: r.finished_at?.toISOString() ?? null,
    items: items.rows.map((i) => ({
      id: i.id,
      label: i.label,
      status: i.status,
      error: i.error_code,
    })),
  };
}

export type BulkOptions = {
  actions: BulkAction[];
  users: { id: string; label: string }[];
  teams: { id: string; label: string }[];
  templates: { id: string; label: string }[];
};

/** What the bulk bar may offer this member (actions by permission; templates without legal effect). */
export async function bulkOptions(ctx: TenantContext, entity: BulkEntity): Promise<BulkOptions> {
  const { rows: perms } = await ctx.db.query<{ key: string }>(
    `SELECT DISTINCT p.key FROM user_roles ur
     JOIN role_permissions rp ON rp.tenant_id = ur.tenant_id AND rp.role_id = ur.role_id
     JOIN permissions p ON p.id = rp.permission_id WHERE ur.user_id = $1`,
    [ctx.userId],
  );
  const held = new Set(perms.map((p) => p.key));
  const actions = BULK_ACTIONS.filter((a) => held.has(PERMISSION[a](entity)));
  const users = await ctx.db.query<{ id: string; label: string }>(
    `SELECT id, display_name AS label FROM users WHERE status = 'active' ORDER BY display_name, id`,
  );
  const teams = await ctx.db.query<{ id: string; label: string }>(
    `SELECT id, name AS label FROM teams WHERE status = 'active' ORDER BY name, id`,
  );
  const templates = await ctx.db.query<{ id: string; label: string }>(
    `SELECT key AS id, name AS label FROM templates
     WHERE channel = 'email' AND status = 'active' AND NOT has_legal_effect ORDER BY name, key`,
  );
  return { actions, users: users.rows, teams: teams.rows, templates: templates.rows };
}
