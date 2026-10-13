import { z } from 'zod';
import { scopeFilter } from '@/server/auth/scope';
import { ConflictError, NotFoundError, type TenantContext } from '@/server/auth/with-tenant';
import { scopedCustomer } from '@/server/collections/service';
import { getMasterKeyring, type MasterKeyring } from '@/server/crypto/keyring';
import { encryptField } from '@/server/crypto/subject-keys';
import { emitEvent } from '@/server/events';

/**
 * Disputes (Sprint 5.1, migration 024): a customer contests one or more of its invoices. The
 * invoices stay in aging, marked (invoice_positions.is_disputed); the rule engine sends no
 * reminder for them. Status machine in the database (disputes_guard): open → in_review →
 * resolved_accepted | resolved_rejected | withdrawn. The resolution note is member free text —
 * encrypted per customer (ADR 0003). Every change: permission dispute.*, scope of the customer,
 * audit + domain event (dispute.opened / dispute.updated).
 *
 * Payment behaviour (unwilling / unable / disputed): the collector's assessment of a customer,
 * code list payment_behaviour — customer.update, audited.
 */

export const DISPUTE_STATUSES = [
  'open',
  'in_review',
  'resolved_accepted',
  'resolved_rejected',
  'withdrawn',
] as const;
export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];
const CLOSED: readonly DisputeStatus[] = ['resolved_accepted', 'resolved_rejected', 'withdrawn'];
const code = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/);

export const newDisputeSchema = z.object({
  customerId: z.uuid(),
  invoiceIds: z.array(z.uuid()).min(1).max(200),
  reasonCode: code,
  ownerUserId: z.uuid().optional(),
  expectedBy: z.iso.date().optional(),
});

export const disputeUpdateSchema = z
  .object({
    status: z.enum(DISPUTE_STATUSES).optional(),
    ownerUserId: z.uuid().nullable().optional(),
    expectedBy: z.iso.date().nullable().optional(),
    resolutionNote: z.string().trim().min(1).max(4000).optional(),
  })
  .refine((v) => Object.keys(v).length > 0)
  .refine((v) => !v.resolutionNote || (v.status && CLOSED.includes(v.status)), {
    path: ['resolutionNote'],
  });

async function codeExists(ctx: TenantContext, listKey: string, value: string): Promise<boolean> {
  const { rowCount } = await ctx.db.query(
    'SELECT 1 FROM code_lists WHERE list_key = $1 AND code = $2 AND is_active',
    [listKey, value],
  );
  return Boolean(rowCount);
}

async function memberExists(ctx: TenantContext, userId: string): Promise<boolean> {
  const { rowCount } = await ctx.db.query(
    `SELECT 1 FROM users WHERE id = $1 AND status = 'active'`,
    [userId],
  );
  return Boolean(rowCount);
}

export async function openDispute(
  ctx: TenantContext,
  input: z.input<typeof newDisputeSchema>,
): Promise<{ id: string }> {
  const data = newDisputeSchema.parse(input);
  await scopedCustomer(ctx, data.customerId, 'dispute.create');
  if (!(await codeExists(ctx, 'dispute_reason', data.reasonCode)))
    throw new ConflictError('invalid_request');
  if (data.ownerUserId && !(await memberExists(ctx, data.ownerUserId)))
    throw new ConflictError('invalid_request');
  const invoiceIds = [...new Set(data.invoiceIds)];
  const own = await ctx.db.query(
    'SELECT id FROM invoices WHERE customer_id = $1 AND id = ANY($2::uuid[])',
    [data.customerId, invoiceIds],
  );
  if (own.rowCount !== invoiceIds.length) throw new NotFoundError();
  const { rows } = await ctx.db.query<{ id: string }>(
    `INSERT INTO disputes (tenant_id, customer_id, reason_code, owner_user_id, expected_by, created_by, updated_by)
     VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $5) RETURNING id`,
    [
      data.customerId,
      data.reasonCode,
      data.ownerUserId ?? ctx.userId,
      data.expectedBy ?? null,
      ctx.userId,
    ],
  );
  const id = rows[0]?.id ?? '';
  await ctx.db.query(
    `INSERT INTO dispute_invoices (tenant_id, dispute_id, invoice_id)
     SELECT app_tenant_id(), $1, unnest($2::uuid[])`,
    [id, invoiceIds],
  );
  await ctx.audit({
    action: 'dispute.opened',
    entityType: 'disputes',
    entityId: id,
    after: {
      customer_id: data.customerId,
      reason_code: data.reasonCode,
      status: 'open',
      invoice_count: invoiceIds.length,
      expected_by: data.expectedBy ?? null,
    },
  });
  await emitEvent(ctx.db, {
    eventType: 'dispute.opened',
    aggregateType: 'disputes',
    aggregateId: id,
    payload: {
      customer_id: data.customerId,
      invoice_ids: invoiceIds,
      reason_code: data.reasonCode,
    },
    requestId: ctx.requestId,
    actorId: ctx.userId,
  });
  return { id };
}

export async function updateDispute(
  ctx: TenantContext,
  id: string,
  input: z.input<typeof disputeUpdateSchema>,
  keyring: MasterKeyring = getMasterKeyring(),
): Promise<{ ok: true }> {
  const data = disputeUpdateSchema.parse(input);
  const permission =
    data.ownerUserId !== undefined && !data.status ? 'dispute.assign' : 'dispute.update';
  const { scope } = await ctx.requirePermission(permission);
  const filter = scopeFilter('customers', { userId: ctx.userId, scope }, 'c', 2);
  const { rows } = await ctx.db.query<{
    customer_id: string;
    status: DisputeStatus;
    owner_user_id: string | null;
    expected_by: string | null;
  }>(
    `SELECT d.customer_id, d.status, d.owner_user_id, d.expected_by::text AS expected_by
     FROM disputes d JOIN customers c ON c.id = d.customer_id
     WHERE d.id = $1 AND ${filter.sql} FOR UPDATE OF d`,
    [id, ...filter.params],
  );
  const cur = rows[0];
  if (!cur) throw new NotFoundError();
  if (CLOSED.includes(cur.status)) throw new ConflictError('conflict');
  if (data.ownerUserId && !(await memberExists(ctx, data.ownerUserId)))
    throw new ConflictError('invalid_request');
  const closing = data.status !== undefined && CLOSED.includes(data.status);
  const note = data.resolutionNote
    ? await encryptField(
        ctx.db,
        keyring,
        { type: 'customer', id: cur.customer_id },
        { table: 'disputes', column: 'resolution_note_enc', rowId: id },
        data.resolutionNote,
      )
    : null;
  try {
    await ctx.db.query(
      `UPDATE disputes SET
         status = coalesce($2, status),
         owner_user_id = CASE WHEN $3::boolean THEN $4::uuid ELSE owner_user_id END,
         expected_by = CASE WHEN $5::boolean THEN $6::date ELSE expected_by END,
         resolved_at = CASE WHEN $7::boolean THEN now() ELSE resolved_at END,
         resolution_note_enc = coalesce($8, resolution_note_enc),
         resolution_note_key_version = coalesce($9, resolution_note_key_version),
         updated_by = $10
       WHERE id = $1`,
      [
        id,
        data.status ?? null,
        data.ownerUserId !== undefined,
        data.ownerUserId ?? null,
        data.expectedBy !== undefined,
        data.expectedBy ?? null,
        closing,
        note?.ciphertext ?? null,
        note?.keyVersion ?? null,
        ctx.userId,
      ],
    );
  } catch (error) {
    if ((error as { code?: string }).code === '23514') throw new ConflictError('conflict');
    throw error;
  }
  await ctx.audit({
    action: 'dispute.updated',
    entityType: 'disputes',
    entityId: id,
    before: { status: cur.status, owner_user_id: cur.owner_user_id, expected_by: cur.expected_by },
    after: {
      status: data.status ?? cur.status,
      owner_user_id: data.ownerUserId !== undefined ? data.ownerUserId : cur.owner_user_id,
      expected_by: data.expectedBy !== undefined ? data.expectedBy : cur.expected_by,
      has_resolution_note: Boolean(note),
    },
  });
  await emitEvent(ctx.db, {
    eventType: 'dispute.updated',
    aggregateType: 'disputes',
    aggregateId: id,
    payload: { customer_id: cur.customer_id, status: data.status ?? cur.status },
    requestId: ctx.requestId,
    actorId: ctx.userId,
  });
  return { ok: true };
}

export type DisputeRow = {
  id: string;
  customerId: string;
  customerName: string | null;
  reasonCode: string;
  status: DisputeStatus;
  ownerUserId: string | null;
  ownerName: string | null;
  openedAt: string;
  expectedBy: string | null;
  invoiceIds: string[];
  invoiceNumbers: string[];
  hasResolutionNote: boolean;
};

export const disputeListQuery = z.object({
  customerId: z.uuid().optional(),
  status: z.enum(['active', 'closed', 'all']).default('active'),
});

export async function listDisputes(
  ctx: TenantContext,
  input: z.input<typeof disputeListQuery> = {},
): Promise<DisputeRow[]> {
  const q = disputeListQuery.parse(input);
  const { scope } = await ctx.requirePermission('dispute.read');
  const filter = scopeFilter('customers', { userId: ctx.userId, scope }, 'c', 3);
  const { rows } = await ctx.db.query<{
    id: string;
    customer_id: string;
    customer_name: string | null;
    reason_code: string;
    status: DisputeStatus;
    owner_user_id: string | null;
    owner_name: string | null;
    opened_at: Date;
    expected_by: string | null;
    invoice_ids: string[];
    invoice_numbers: string[];
    has_note: boolean;
  }>(
    `SELECT d.id, d.customer_id, c.display_name AS customer_name, d.reason_code, d.status, d.owner_user_id,
            u.display_name AS owner_name, d.opened_at, d.expected_by::text AS expected_by,
            coalesce(array_agg(i.id ORDER BY i.number) FILTER (WHERE i.id IS NOT NULL), '{}') AS invoice_ids,
            coalesce(array_agg(i.number ORDER BY i.number) FILTER (WHERE i.id IS NOT NULL), '{}') AS invoice_numbers,
            d.resolution_note_enc IS NOT NULL AS has_note
     FROM disputes d
     JOIN customers c ON c.id = d.customer_id
     LEFT JOIN users u ON u.id = d.owner_user_id
     LEFT JOIN dispute_invoices di ON di.dispute_id = d.id
     LEFT JOIN invoices i ON i.id = di.invoice_id
     WHERE ($1::uuid IS NULL OR d.customer_id = $1)
       AND ($2 = 'all' OR ($2 = 'active') = (d.status IN ('open', 'in_review')))
       AND ${filter.sql}
     GROUP BY d.id, c.display_name, u.display_name
     ORDER BY d.opened_at DESC
     LIMIT 500`,
    [q.customerId ?? null, q.status, ...filter.params],
  );
  return rows.map((r) => ({
    id: r.id,
    customerId: r.customer_id,
    customerName: r.customer_name,
    reasonCode: r.reason_code,
    status: r.status,
    ownerUserId: r.owner_user_id,
    ownerName: r.owner_name,
    openedAt: r.opened_at.toISOString(),
    expectedBy: r.expected_by,
    invoiceIds: r.invoice_ids,
    invoiceNumbers: r.invoice_numbers,
    hasResolutionNote: r.has_note,
  }));
}

export const paymentBehaviourSchema = z.object({ code: code.nullable() });

export async function setPaymentBehaviour(
  ctx: TenantContext,
  customerId: string,
  input: z.input<typeof paymentBehaviourSchema>,
): Promise<{ ok: true }> {
  const { code: value } = paymentBehaviourSchema.parse(input);
  await scopedCustomer(ctx, customerId, 'customer.update');
  if (value && !(await codeExists(ctx, 'payment_behaviour', value)))
    throw new ConflictError('invalid_request');
  const before = await ctx.db.query<{ code: string | null }>(
    'SELECT payment_behaviour_code AS code FROM customers WHERE id = $1 FOR UPDATE',
    [customerId],
  );
  await ctx.db.query(
    'UPDATE customers SET payment_behaviour_code = $2, updated_by = $3 WHERE id = $1',
    [customerId, value, ctx.userId],
  );
  await ctx.audit({
    action: 'customer.payment_behaviour_set',
    entityType: 'customers',
    entityId: customerId,
    before: { payment_behaviour_code: before.rows[0]?.code ?? null },
    after: { payment_behaviour_code: value },
  });
  return { ok: true };
}
