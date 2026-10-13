import { z } from 'zod';
import type { AuditEntry } from '@/server/auth/audit';
import { PermissionDeniedError } from '@/server/auth/permissions';
import { scopeFilter } from '@/server/auth/scope';
import { ConflictError, NotFoundError, type TenantContext } from '@/server/auth/with-tenant';
import { getMasterKeyring, type MasterKeyring } from '@/server/crypto/keyring';
import { encryptField, type Queryable } from '@/server/crypto/subject-keys';
import { emitEvent } from '@/server/events';
import {
  fromMinor,
  min,
  money,
  sub,
  toDecimal,
  toMinor,
  zero,
  type Money,
} from '@/server/fx/money';

/**
 * Collection work (task 2.4): cases, promises, activities, manual payments, legal handover, and
 * the daily promise evaluation. Every action checks its permission, reaches the customer only
 * within scope (scopeFilter), writes audit + a domain event (case.*, promise.*, activity.logged,
 * payment.received). Money stays decimal strings / bigint cents (rule 18); allocations go through
 * payment_allocations — amount_open is derived by the database, never written here.
 *
 * Legal handover (rules 11, 19): never a direct stage change — an approval_request
 * 'case.legal_handover' (maker: approval.create; checker: approval.legal_handover; four eyes).
 * For a natural person the request is also a `decisions` row that only a human approves.
 */

export const LEGAL_HANDOVER_ACTION = 'case.legal_handover';

const amountSchema = z.string().regex(/^\d{1,16}(\.\d{1,2})?$/);
const dateSchema = z.iso.date();

/** The customer within the caller's scope (for `permission`) or 404. */
async function scopedCustomer(ctx: TenantContext, customerId: string, permission: string) {
  const { scope } = await ctx.requirePermission(permission);
  const filter = scopeFilter('customers', { userId: ctx.userId, scope }, 'c', 2);
  const { rows } = await ctx.db.query<{ id: string; is_natural_person: boolean }>(
    `SELECT c.id, c.is_natural_person FROM customers c WHERE c.id = $1 AND ${filter.sql}`,
    [customerId, ...filter.params],
  );
  const row = rows[0];
  if (!row) throw new NotFoundError();
  return row;
}

/** A case whose customer is within scope (for `permission`), locked for update. */
async function scopedCase(ctx: TenantContext, caseId: string, permission: string) {
  const { scope } = await ctx.requirePermission(permission);
  const filter = scopeFilter('customers', { userId: ctx.userId, scope }, 'c', 2);
  const { rows } = await ctx.db.query<{
    id: string;
    customer_id: string;
    status: string;
    stage_code: string;
    priority: string;
    owner_user_id: string | null;
    is_natural_person: boolean;
  }>(
    `SELECT k.id, k.customer_id, k.status, k.stage_code, k.priority, k.owner_user_id, c.is_natural_person
     FROM collection_cases k JOIN customers c ON c.id = k.customer_id
     WHERE k.id = $1 AND ${filter.sql} FOR UPDATE OF k`,
    [caseId, ...filter.params],
  );
  const row = rows[0];
  if (!row) throw new NotFoundError();
  return row;
}

async function event(
  ctx: TenantContext,
  type: string,
  aggregateType: string,
  aggregateId: string,
  payload: Record<string, unknown> = {},
) {
  await emitEvent(ctx.db, {
    eventType: type,
    aggregateType,
    aggregateId,
    payload,
    requestId: ctx.requestId,
    actorId: ctx.userId,
  });
}

export async function localToday(
  db: Queryable,
  companyId?: string | null,
): Promise<{ today: string; companyId: string }> {
  const { rows } = await db.query<{ today: string; id: string }>(
    `SELECT (now() AT TIME ZONE le.timezone)::date::text AS today, tc.id
     FROM tenant_companies tc JOIN legal_entities le ON le.id = tc.legal_entity_id
     WHERE ($1::uuid IS NULL OR tc.id = $1)
     ORDER BY tc.is_default DESC, tc.created_at LIMIT 1`,
    [companyId ?? null],
  );
  const row = rows[0];
  if (!row) throw new NotFoundError();
  return { today: row.today, companyId: row.id };
}

// ---------------------------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------------------------

export const newCaseSchema = z.object({
  customerId: z.uuid(),
  invoiceIds: z.array(z.uuid()).min(1).max(200),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  ownerUserId: z.uuid().optional(),
});

export async function createCase(
  ctx: TenantContext,
  input: z.input<typeof newCaseSchema>,
): Promise<{ id: string }> {
  const data = newCaseSchema.parse(input);
  await scopedCustomer(ctx, data.customerId, 'case.create');
  if (data.ownerUserId && data.ownerUserId !== ctx.userId)
    await ctx.requirePermission('case.assign');
  const invoices = await ctx.db.query<{ id: string }>(
    `SELECT id FROM invoices WHERE id = ANY($1::uuid[]) AND customer_id = $2 AND amount_open > 0
       AND accounting_status NOT IN ('credited', 'cancelled')`,
    [data.invoiceIds, data.customerId],
  );
  if (invoices.rowCount !== new Set(data.invoiceIds).size)
    throw new ConflictError('invalid_request');
  const { rows } = await ctx.db.query<{ id: string }>(
    `INSERT INTO collection_cases (tenant_id, customer_id, owner_user_id, stage_code, priority, created_by, updated_by)
     VALUES (app_tenant_id(), $1, $2, 'new', $3, $4, $4) RETURNING id`,
    [data.customerId, data.ownerUserId ?? ctx.userId, data.priority, ctx.userId],
  );
  const id = rows[0]?.id ?? '';
  await ctx.db.query(
    `INSERT INTO case_invoices (tenant_id, case_id, invoice_id, created_by)
     SELECT app_tenant_id(), $1, unnest($2::uuid[]), $3`,
    [id, [...new Set(data.invoiceIds)], ctx.userId],
  );
  await ctx.audit({
    action: 'case.opened',
    entityType: 'collection_cases',
    entityId: id,
    after: {
      customer_id: data.customerId,
      stage_code: 'new',
      priority: data.priority,
      invoices: data.invoiceIds.length,
    },
  });
  await event(ctx, 'case.opened', 'collection_cases', id, {
    customer_id: data.customerId,
    invoices: data.invoiceIds.length,
  });
  return { id };
}

export const caseUpdateSchema = z
  .object({
    stageCode: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,40}$/)
      .optional(),
    priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
    ownerUserId: z.uuid().optional(),
    close: z.literal(true).optional(),
  })
  .refine((v) => Object.keys(v).length > 0);

export async function updateCase(
  ctx: TenantContext,
  caseId: string,
  input: z.input<typeof caseUpdateSchema>,
) {
  const data = caseUpdateSchema.parse(input);
  const k = await scopedCase(ctx, caseId, 'case.update');
  if (k.status !== 'open') throw new ConflictError('conflict');
  // Rule 11: the legal stage is reached only through an approved handover request.
  if (data.stageCode === 'legal') throw new ConflictError('approval_required');
  if (data.ownerUserId && data.ownerUserId !== k.owner_user_id)
    await ctx.requirePermission('case.assign');
  const before = {
    stage_code: k.stage_code,
    priority: k.priority,
    owner_user_id: k.owner_user_id,
    status: k.status,
  };
  const after = {
    stage_code: data.stageCode ?? k.stage_code,
    priority: data.priority ?? k.priority,
    owner_user_id: data.ownerUserId ?? k.owner_user_id,
    status: data.close ? 'closed' : 'open',
  };
  await ctx.db.query(
    `UPDATE collection_cases SET stage_code = $2, priority = $3, owner_user_id = $4, status = $5,
            closed_at = CASE WHEN $5 = 'closed' THEN now() END, updated_by = $6
     WHERE id = $1`,
    [caseId, after.stage_code, after.priority, after.owner_user_id, after.status, ctx.userId],
  );
  await ctx.audit({
    action: 'case.updated',
    entityType: 'collection_cases',
    entityId: caseId,
    before,
    after,
  });
  if (after.stage_code !== before.stage_code) {
    await event(ctx, 'case.stage_changed', 'collection_cases', caseId, {
      from: before.stage_code,
      to: after.stage_code,
    });
  }
  if (after.owner_user_id !== before.owner_user_id) {
    await event(ctx, 'case.assigned', 'collection_cases', caseId, {
      owner_user_id: after.owner_user_id,
    });
  }
  if (after.priority !== before.priority) {
    await event(ctx, 'case.priority_changed', 'collection_cases', caseId, {
      from: before.priority,
      to: after.priority,
    });
  }
  if (data.close) await event(ctx, 'case.closed', 'collection_cases', caseId);
  return { ok: true };
}

export type CaseDetail = {
  id: string;
  customerId: string;
  customerName: string | null;
  stage: string;
  status: string;
  priority: string;
  ownerUserId: string | null;
  ownerName: string | null;
  openedAt: string;
  legalPending: boolean;
  invoices: {
    id: string;
    number: string;
    dueDate: string;
    currency: string;
    amountOpen: string;
    daysOverdue: number;
  }[];
  timeline: {
    at: string;
    kind: 'event' | 'activity' | 'run' | 'mail';
    type: string;
    actorName: string | null;
    data: Record<string, unknown>;
  }[];
};

export async function getCase(ctx: TenantContext, caseId: string): Promise<CaseDetail> {
  const { scope } = await ctx.requirePermission('case.read');
  const filter = scopeFilter('customers', { userId: ctx.userId, scope }, 'c', 2);
  const { rows } = await ctx.db.query<{
    id: string;
    customer_id: string;
    customer_name: string | null;
    stage_code: string;
    status: string;
    priority: string;
    owner_user_id: string | null;
    owner_name: string | null;
    opened_at: Date;
    legal_pending: boolean;
  }>(
    `SELECT k.id, k.customer_id, c.display_name AS customer_name, k.stage_code, k.status, k.priority,
            k.owner_user_id, u.display_name AS owner_name, k.opened_at,
            EXISTS (SELECT 1 FROM approval_requests a WHERE a.action_type = 'case.legal_handover'
                      AND a.entity_id = k.id AND a.status = 'pending') AS legal_pending
     FROM collection_cases k JOIN customers c ON c.id = k.customer_id
     LEFT JOIN users u ON u.id = k.owner_user_id
     WHERE k.id = $1 AND ${filter.sql}`,
    [caseId, ...filter.params],
  );
  const k = rows[0];
  if (!k) throw new NotFoundError();
  const invoices = await ctx.db.query<{
    invoice_id: string;
    number: string;
    due_date: string;
    currency: string;
    amount_open: string;
    days_overdue: number;
  }>(
    `SELECT p.invoice_id, p.number, p.due_date::text, p.currency, p.amount_open, p.days_overdue
     FROM case_invoices ci JOIN invoice_positions p ON p.invoice_id = ci.invoice_id
     WHERE ci.case_id = $1 ORDER BY p.due_date`,
    [caseId],
  );
  // Timeline: domain events of the case and its promises + activities logged on the case.
  const timeline = await ctx.db.query<{
    at: Date;
    kind: 'event' | 'activity' | 'run' | 'mail';
    type: string;
    actor_name: string | null;
    data: Record<string, unknown>;
  }>(
    `SELECT e.occurred_at AS at, 'event' AS kind, e.event_type AS type, u.display_name AS actor_name, e.payload AS data
     FROM domain_events e LEFT JOIN users u ON u.id = e.created_by
     WHERE (e.aggregate_type = 'collection_cases' AND e.aggregate_id = $1)
        OR (e.aggregate_type = 'promises' AND e.aggregate_id IN (SELECT id FROM promises WHERE case_id = $1))
     UNION ALL
     SELECT a.occurred_at, 'activity', a.kind, u.display_name,
            jsonb_build_object('outcome', a.outcome_code, 'next_action', a.next_action_code,
                               'next_action_on', a.next_action_on, 'has_note', a.note_enc IS NOT NULL)
     FROM activities a JOIN users u ON u.id = a.actor_user_id WHERE a.case_id = $1
     UNION ALL
     SELECT r.started_at, 'run', r.status, NULL, r.explanation
     FROM workflow_runs r WHERE r.case_id = $1 AND r.status <> 'skipped'
     UNION ALL
     SELECT m.created_at, 'mail', 'mail.out', NULL, jsonb_build_object('kind', m.kind, 'status', m.status)
     FROM mail_outbox m WHERE m.case_id = $1
     UNION ALL
     SELECT i.received_at, 'mail', 'mail.in', NULL, '{}'::jsonb
     FROM mail_inbox i WHERE i.case_id = $1 AND NOT i.is_bounce
     ORDER BY 1 DESC LIMIT 200`,
    [caseId],
  );
  return {
    id: k.id,
    customerId: k.customer_id,
    customerName: k.customer_name,
    stage: k.stage_code,
    status: k.status,
    priority: k.priority,
    ownerUserId: k.owner_user_id,
    ownerName: k.owner_name,
    openedAt: k.opened_at.toISOString(),
    legalPending: k.legal_pending,
    invoices: invoices.rows.map((i) => ({
      id: i.invoice_id,
      number: i.number,
      dueDate: i.due_date,
      currency: i.currency,
      amountOpen: i.amount_open,
      daysOverdue: i.days_overdue,
    })),
    timeline: timeline.rows.map((r) => ({
      at: r.at.toISOString(),
      kind: r.kind,
      type: r.type,
      actorName: r.actor_name,
      data: r.data,
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// Legal handover (maker-checker, rules 11 and 19)
// ---------------------------------------------------------------------------------------------

export const handoverSchema = z.object({ reason: z.string().trim().min(1).max(500) });

export async function requestLegalHandover(
  ctx: TenantContext,
  caseId: string,
  input: z.input<typeof handoverSchema>,
): Promise<{ approvalId: string }> {
  await ctx.requirePermission('approval.create');
  const { reason } = handoverSchema.parse(input);
  const k = await scopedCase(ctx, caseId, 'case.update');
  if (k.status !== 'open' || k.stage_code === 'legal') throw new ConflictError('conflict');
  const pending = await ctx.db.query(
    `SELECT 1 FROM approval_requests WHERE action_type = $1 AND entity_id = $2 AND status = 'pending'`,
    [LEGAL_HANDOVER_ACTION, caseId],
  );
  if (pending.rowCount) throw new ConflictError('conflict');
  const { rows } = await ctx.db.query<{ id: string }>(
    `INSERT INTO approval_requests (tenant_id, action_type, entity_type, entity_id, payload, requested_by,
                                    request_id, created_by)
     VALUES (app_tenant_id(), $1, 'collection_cases', $2,
             jsonb_build_object('customer_id', $3::uuid, 'natural_person', $4::boolean), $5, $6, $5)
     RETURNING id`,
    [LEGAL_HANDOVER_ACTION, caseId, k.customer_id, k.is_natural_person, ctx.userId, ctx.requestId],
  );
  const approvalId = rows[0]?.id ?? '';
  if (k.is_natural_person) {
    // Rule 19: a decision with legal effect on a natural person — human, approved by someone else.
    await ctx.db.query(
      `INSERT INTO decisions (tenant_id, customer_id, decision_type, has_legal_effect, source, status,
                              rationale, proposed_by, approval_request_id, request_id, created_by)
       VALUES (app_tenant_id(), $1, 'legal_handover', true, 'human', 'proposed', $2, $3, $4, $5, $3)`,
      [k.customer_id, reason, ctx.userId, approvalId, ctx.requestId],
    );
  }
  await ctx.audit({
    action: 'approval_request.created',
    entityType: 'approval_requests',
    entityId: approvalId,
    after: {
      action_type: LEGAL_HANDOVER_ACTION,
      entity_type: 'collection_cases',
      entity_id: caseId,
      status: 'pending',
    },
  });
  await event(ctx, 'case.legal_handover_requested', 'collection_cases', caseId, {
    approval_id: approvalId,
  });
  return { approvalId };
}

export const legalDecisionSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  note: z.string().trim().max(500).optional(),
});

/** Checker side; routed from approvals/service decideApproval(). */
export async function decideLegalHandover(
  ctx: TenantContext,
  approvalId: string,
  input: z.input<typeof legalDecisionSchema>,
): Promise<{ status: 'approved' | 'rejected' }> {
  await ctx.requirePermission('approval.legal_handover');
  const { decision, note } = legalDecisionSchema.parse(input);
  if (decision === 'reject' && !note) throw new ConflictError('invalid_request');
  const { rows } = await ctx.db.query<{ status: string; requested_by: string; entity_id: string }>(
    `SELECT status, requested_by, entity_id FROM approval_requests WHERE id = $1 AND action_type = $2 FOR UPDATE`,
    [approvalId, LEGAL_HANDOVER_ACTION],
  );
  const req = rows[0];
  if (!req) throw new NotFoundError();
  if (req.status !== 'pending') throw new ConflictError('not_pending');
  if (req.requested_by === ctx.userId) throw new PermissionDeniedError();
  const status = decision === 'approve' ? 'approved' : 'rejected';
  await ctx.db.query(
    `UPDATE approval_requests SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4,
            updated_by = $3 WHERE id = $1`,
    [approvalId, status, ctx.userId, note ?? null],
  );
  await ctx.db.query(
    `UPDATE decisions SET status = $2, approved_by = CASE WHEN $2 = 'approved' THEN $3::uuid END,
            approved_at = CASE WHEN $2 = 'approved' THEN now() END, updated_by = $3
     WHERE approval_request_id = $1 AND status = 'proposed'`,
    [approvalId, status, ctx.userId],
  );
  await ctx.audit({
    action: `approval_request.${status}`,
    entityType: 'approval_requests',
    entityId: approvalId,
    before: { status: 'pending' },
    after: { status },
  });
  if (status === 'approved') {
    const k = await ctx.db.query<{ stage_code: string }>(
      `SELECT stage_code FROM collection_cases WHERE id = $1 AND status = 'open' FOR UPDATE`,
      [req.entity_id],
    );
    const from = k.rows[0]?.stage_code;
    if (!from) throw new ConflictError('conflict');
    await ctx.db.query(
      `UPDATE collection_cases SET stage_code = 'legal', legal_approval_id = $2, updated_by = $3 WHERE id = $1`,
      [req.entity_id, approvalId, ctx.userId],
    );
    await ctx.audit({
      action: 'case.updated',
      entityType: 'collection_cases',
      entityId: req.entity_id,
      before: { stage_code: from },
      after: { stage_code: 'legal', legal_approval_id: approvalId },
    });
    await event(ctx, 'case.stage_changed', 'collection_cases', req.entity_id, {
      from,
      to: 'legal',
      approval_id: approvalId,
    });
  } else {
    await event(ctx, 'case.legal_handover_rejected', 'collection_cases', req.entity_id, {
      approval_id: approvalId,
    });
  }
  return { status };
}

// ---------------------------------------------------------------------------------------------
// Promises
// ---------------------------------------------------------------------------------------------

export const newPromiseSchema = z.object({
  customerId: z.uuid(),
  caseId: z.uuid().optional(),
  amount: amountSchema,
  currency: z.string().regex(/^[A-Z]{3}$/),
  promisedOn: dateSchema,
});

export async function createPromise(
  ctx: TenantContext,
  input: z.input<typeof newPromiseSchema>,
): Promise<{ id: string }> {
  const data = newPromiseSchema.parse(input);
  await scopedCustomer(ctx, data.customerId, 'promise.create');
  if (toMinor(data.amount) <= 0n) throw new ConflictError('invalid_request');
  if (data.caseId) {
    const k = await ctx.db.query(
      'SELECT 1 FROM collection_cases WHERE id = $1 AND customer_id = $2',
      [data.caseId, data.customerId],
    );
    if (!k.rowCount) throw new NotFoundError();
  }
  const { today, companyId } = await localToday(ctx.db);
  if (data.promisedOn < today) throw new ConflictError('invalid_request');
  const { rows } = await ctx.db.query<{ id: string }>(
    `INSERT INTO promises (tenant_id, customer_id, case_id, company_id, amount, currency, promised_on, made_on,
                           created_by, updated_by)
     VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $8) RETURNING id`,
    [
      data.customerId,
      data.caseId ?? null,
      companyId,
      data.amount,
      data.currency,
      data.promisedOn,
      today,
      ctx.userId,
    ],
  );
  const id = rows[0]?.id ?? '';
  await ctx.audit({
    action: 'promise.created',
    entityType: 'promises',
    entityId: id,
    after: {
      amount: data.amount,
      currency: data.currency,
      promised_on: data.promisedOn,
      case_id: data.caseId ?? null,
    },
  });
  await event(ctx, 'promise.created', 'promises', id, {
    customer_id: data.customerId,
    case_id: data.caseId ?? null,
  });
  return { id };
}

export const promiseUpdateSchema = z
  .object({
    amount: amountSchema.optional(),
    promisedOn: dateSchema.optional(),
    cancel: z.literal(true).optional(),
  })
  .refine((v) => Object.keys(v).length > 0);

async function scopedPromise(ctx: TenantContext, promiseId: string, permission: string) {
  const { scope } = await ctx.requirePermission(permission);
  const filter = scopeFilter('customers', { userId: ctx.userId, scope }, 'c', 2);
  const { rows } = await ctx.db.query<{
    id: string;
    customer_id: string;
    status: string;
    amount: string;
    promised_on: string;
    case_id: string | null;
    today: string;
  }>(
    `SELECT pr.id, pr.customer_id, pr.status, pr.amount, pr.promised_on::text, pr.case_id,
            (now() AT TIME ZONE le.timezone)::date::text AS today
     FROM promises pr JOIN customers c ON c.id = pr.customer_id
     JOIN tenant_companies tc ON tc.id = pr.company_id JOIN legal_entities le ON le.id = tc.legal_entity_id
     WHERE pr.id = $1 AND ${filter.sql} FOR UPDATE OF pr`,
    [promiseId, ...filter.params],
  );
  const row = rows[0];
  if (!row) throw new NotFoundError();
  return row;
}

export async function updatePromise(
  ctx: TenantContext,
  promiseId: string,
  input: z.input<typeof promiseUpdateSchema>,
) {
  const data = promiseUpdateSchema.parse(input);
  const p = await scopedPromise(ctx, promiseId, 'promise.update');
  if (p.status !== 'pending') throw new ConflictError('conflict');
  if (data.cancel) {
    await ctx.db.query(`UPDATE promises SET status = 'cancelled', updated_by = $2 WHERE id = $1`, [
      promiseId,
      ctx.userId,
    ]);
    await ctx.audit({
      action: 'promise.cancelled',
      entityType: 'promises',
      entityId: promiseId,
      before: { status: 'pending' },
      after: { status: 'cancelled' },
    });
    await event(ctx, 'promise.cancelled', 'promises', promiseId, { case_id: p.case_id });
    return { ok: true };
  }
  if (data.promisedOn && data.promisedOn < p.today) throw new ConflictError('invalid_request');
  if (data.amount && toMinor(data.amount) <= 0n) throw new ConflictError('invalid_request');
  const after = { amount: data.amount ?? p.amount, promised_on: data.promisedOn ?? p.promised_on };
  await ctx.db.query(
    'UPDATE promises SET amount = $2, promised_on = $3, updated_by = $4 WHERE id = $1',
    [promiseId, after.amount, after.promised_on, ctx.userId],
  );
  await ctx.audit({
    action: 'promise.updated',
    entityType: 'promises',
    entityId: promiseId,
    before: { amount: p.amount, promised_on: p.promised_on },
    after,
  });
  await event(ctx, 'promise.updated', 'promises', promiseId, { case_id: p.case_id });
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// Activities
// ---------------------------------------------------------------------------------------------

export const newActivitySchema = z
  .object({
    customerId: z.uuid(),
    caseId: z.uuid().optional(),
    kind: z.enum(['call', 'email', 'note', 'meeting']),
    outcomeCode: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,40}$/)
      .optional(),
    nextActionCode: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,40}$/)
      .optional(),
    nextActionOn: dateSchema.optional(),
    note: z.string().trim().min(1).max(4000).optional(),
  })
  .refine((v) => !v.nextActionOn || v.nextActionCode, { path: ['nextActionCode'] });

export async function createActivity(
  ctx: TenantContext,
  input: z.input<typeof newActivitySchema>,
  keyring: MasterKeyring = getMasterKeyring(),
): Promise<{ id: string }> {
  const data = newActivitySchema.parse(input);
  await scopedCustomer(ctx, data.customerId, 'activity.create');
  if (data.caseId) {
    const k = await ctx.db.query(
      'SELECT 1 FROM collection_cases WHERE id = $1 AND customer_id = $2',
      [data.caseId, data.customerId],
    );
    if (!k.rowCount) throw new NotFoundError();
  }
  const id = crypto.randomUUID();
  // Free-text note: encrypted per customer (ADR 0003, PII registry: activities.note_enc).
  const note = data.note
    ? await encryptField(
        ctx.db,
        keyring,
        { type: 'customer', id: data.customerId },
        { table: 'activities', column: 'note_enc', rowId: id },
        data.note,
      )
    : null;
  await ctx.db.query(
    `INSERT INTO activities (id, tenant_id, customer_id, case_id, kind, outcome_code, next_action_code, next_action_on,
                             note_enc, note_key_version, actor_user_id, created_by)
     VALUES ($1, app_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)`,
    [
      id,
      data.customerId,
      data.caseId ?? null,
      data.kind,
      data.outcomeCode ?? null,
      data.nextActionCode ?? null,
      data.nextActionOn ?? null,
      note?.ciphertext ?? null,
      note?.keyVersion ?? null,
      ctx.userId,
    ],
  );
  await ctx.audit({
    action: 'activity.logged',
    entityType: 'activities',
    entityId: id,
    after: {
      kind: data.kind,
      outcome_code: data.outcomeCode ?? null,
      next_action_code: data.nextActionCode ?? null,
      case_id: data.caseId ?? null,
    },
  });
  await event(ctx, 'activity.logged', 'activities', id, {
    customer_id: data.customerId,
    case_id: data.caseId ?? null,
    kind: data.kind,
  });
  return { id };
}

// ---------------------------------------------------------------------------------------------
// Manual payment (marked by a person) → allocations → promise fulfilment
// ---------------------------------------------------------------------------------------------

export const newPaymentSchema = z.object({
  customerId: z.uuid(),
  amount: amountSchema,
  currency: z.string().regex(/^[A-Z]{3}$/),
  paidOn: dateSchema,
  reference: z.string().trim().min(1).max(200).optional(),
  // Explicit invoice first (domain default: FIFO by due date unless an invoice is named).
  invoiceId: z.uuid().optional(),
});

export async function recordPayment(
  ctx: TenantContext,
  input: z.input<typeof newPaymentSchema>,
): Promise<{ id: string; allocated: string; unallocated: string; fulfilled: string[] }> {
  const data = newPaymentSchema.parse(input);
  await scopedCustomer(ctx, data.customerId, 'payment.create');
  const amount = money(data.amount, data.currency);
  if (amount.minor <= 0n) throw new ConflictError('invalid_request');
  const { today } = await localToday(ctx.db);
  if (data.paidOn > today) throw new ConflictError('invalid_request');
  const source = await ctx.db.query<{ id: string }>(
    `SELECT id FROM data_sources WHERE name = 'file-import'`,
  );
  const sourceId = source.rows[0]?.id;
  if (!sourceId) throw new ConflictError('conflict');
  const { rows } = await ctx.db.query<{ id: string }>(
    `INSERT INTO payments (tenant_id, customer_id, source_id, kind, paid_on, amount, currency, reference, created_by, updated_by)
     VALUES (app_tenant_id(), $1, $2, 'received', $3, $4, $5, $6, $7, $7) RETURNING id`,
    [
      data.customerId,
      sourceId,
      data.paidOn,
      data.amount,
      data.currency,
      data.reference ?? null,
      ctx.userId,
    ],
  );
  const id = rows[0]?.id ?? '';

  // Open invoices of the customer in the payment currency: the named one first, then FIFO by due date.
  const open = await ctx.db.query<{ id: string; amount_open: string }>(
    `SELECT id, amount_open FROM invoices
     WHERE customer_id = $1 AND currency = $2 AND amount_open > 0 AND accounting_status NOT IN ('credited', 'cancelled')
     ORDER BY (id = $3::uuid) DESC NULLS LAST, due_date, issue_date, number FOR UPDATE`,
    [data.customerId, data.currency, data.invoiceId ?? null],
  );
  if (data.invoiceId && open.rows[0]?.id !== data.invoiceId) throw new NotFoundError();
  let left: Money = amount;
  let allocated: Money = zero(data.currency);
  for (const inv of open.rows) {
    if (left.minor === 0n) break;
    const part = min(left, money(inv.amount_open, data.currency));
    await ctx.db.query(
      `INSERT INTO payment_allocations (tenant_id, payment_id, invoice_id, amount, method, created_by)
       VALUES (app_tenant_id(), $1, $2, $3, $4, $5)`,
      [id, inv.id, toDecimal(part), data.invoiceId === inv.id ? 'explicit' : 'fifo', ctx.userId],
    );
    left = sub(left, part);
    allocated = { minor: allocated.minor + part.minor, currency: data.currency };
  }
  await ctx.audit({
    action: 'payment.recorded',
    entityType: 'payments',
    entityId: id,
    after: {
      amount: data.amount,
      currency: data.currency,
      paid_on: data.paidOn,
      allocated: toDecimal(allocated),
    },
  });
  await event(ctx, 'payment.received', 'payments', id, {
    customer_id: data.customerId,
    allocated: toDecimal(allocated),
    unallocated: toDecimal(left),
  });
  const fulfilled = await fulfilPromises(
    ctx.db,
    (e) => ctx.audit(e),
    data.customerId,
    ctx.userId,
    ctx.requestId,
  );
  return { id, allocated: toDecimal(allocated), unallocated: toDecimal(left), fulfilled };
}

/** Paid toward a promise: money received from the customer since the promise was made. */
const PAID_SINCE_MADE = `coalesce((SELECT sum(py.amount) FROM payments py
   WHERE py.customer_id = pr.customer_id AND py.currency = pr.currency AND py.payment_kind = 'payment'
     AND py.paid_on >= pr.made_on AND py.paid_on <= $2::date), 0)`;

/** Pending promises already covered by payments become fulfilled right away. */
async function fulfilPromises(
  db: Queryable,
  audit: (entry: AuditEntry) => Promise<void>,
  customerId: string,
  actorId: string | null,
  requestId: string | null,
): Promise<string[]> {
  const { rows } = await db.query<{ id: string; paid: string; case_id: string | null }>(
    `SELECT pr.id, pr.case_id, ${PAID_SINCE_MADE}::numeric(18,2)::text AS paid
     FROM promises pr WHERE pr.customer_id = $1 AND pr.status = 'pending'
       AND ${PAID_SINCE_MADE} >= pr.amount
     FOR UPDATE OF pr`,
    [customerId, '9999-12-31'],
  );
  for (const p of rows) {
    await db.query(
      `UPDATE promises SET status = 'fulfilled', paid_amount = $2, evaluated_at = now(), updated_by = $3 WHERE id = $1`,
      [p.id, p.paid, actorId],
    );
    await audit({
      action: 'promise.fulfilled',
      entityType: 'promises',
      entityId: p.id,
      before: { status: 'pending' },
      after: { status: 'fulfilled', paid_amount: p.paid },
    });
    await emitEvent(db, {
      eventType: 'promise.fulfilled',
      aggregateType: 'promises',
      aggregateId: p.id,
      payload: { case_id: p.case_id },
      requestId,
      actorId,
    });
  }
  return rows.map((r) => r.id);
}

// ---------------------------------------------------------------------------------------------
// Daily job (tenant-local, after 06:00): promise evaluation + invoice.overdue events
// ---------------------------------------------------------------------------------------------

/**
 * Promise broken = D + promise_grace_days (default 1) in the company's zone without payments
 * ≥ the promised amount; partial when something but not enough was paid. Each promise is
 * evaluated against its own window (made_on … promised_on + grace − 1). Invoices whose due day
 * ended yesterday (company zone) get one invoice.overdue event.
 */
export async function runDailyCollections(
  db: Queryable,
  audit: (entry: AuditEntry) => Promise<void>,
): Promise<{ fulfilled: number; partial: number; broken: number; overdue: number }> {
  const { rows } = await db.query<{
    id: string;
    amount: string;
    paid: string;
    case_id: string | null;
  }>(
    `WITH due AS (
       SELECT pr.*, (now() AT TIME ZONE le.timezone)::date AS today, ts.promise_grace_days AS grace
       FROM promises pr
       JOIN tenant_companies tc ON tc.id = pr.company_id
       JOIN legal_entities le ON le.id = tc.legal_entity_id
       CROSS JOIN tenant_settings ts
       WHERE pr.status = 'pending')
     SELECT d.id, d.amount, d.case_id,
            coalesce((SELECT sum(py.amount) FROM payments py
                      WHERE py.customer_id = d.customer_id AND py.currency = d.currency AND py.payment_kind = 'payment'
                        AND py.paid_on >= d.made_on AND py.paid_on < d.promised_on + d.grace), 0)::numeric(18,2)::text AS paid
     FROM due d WHERE d.today >= d.promised_on + d.grace`,
  );
  const counts = { fulfilled: 0, partial: 0, broken: 0, overdue: 0 };
  for (const p of rows) {
    const paid = toMinor(p.paid);
    const status = paid >= toMinor(p.amount) ? 'fulfilled' : paid > 0n ? 'partial' : 'broken';
    counts[status] += 1;
    await db.query(
      `UPDATE promises SET status = $2, paid_amount = $3, evaluated_at = now() WHERE id = $1`,
      [p.id, status, fromMinor(paid)],
    );
    await audit({
      action: `promise.${status}`,
      entityType: 'promises',
      entityId: p.id,
      before: { status: 'pending' },
      after: { status, paid_amount: fromMinor(paid) },
    });
    await emitEvent(db, {
      eventType: `promise.${status}`,
      aggregateType: 'promises',
      aggregateId: p.id,
      payload: { case_id: p.case_id },
    });
  }
  const overdue = await db.query<{ invoice_id: string }>(
    `SELECT p.invoice_id FROM invoice_positions p
     WHERE p.is_open AND p.due_date = p.local_today - 1
       AND NOT EXISTS (SELECT 1 FROM domain_events e WHERE e.event_type = 'invoice.overdue' AND e.aggregate_id = p.invoice_id)`,
  );
  for (const r of overdue.rows) {
    await emitEvent(db, {
      eventType: 'invoice.overdue',
      aggregateType: 'invoices',
      aggregateId: r.invoice_id,
    });
  }
  counts.overdue = overdue.rows.length;
  return counts;
}
