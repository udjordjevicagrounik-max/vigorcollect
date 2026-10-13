import { z } from 'zod';
import type { Scope } from '@/server/auth/permissions';
import { scopeFilter } from '@/server/auth/scope';
import { NotFoundError, type TenantContext } from '@/server/auth/with-tenant';
import { getMasterKeyring, type MasterKeyring } from '@/server/crypto/keyring';
import { decryptField } from '@/server/crypto/subject-keys';
import { readCustomerName } from '@/server/customers/repository';

/**
 * Receivables reads (task 2.3): customer list, Customer 360, dashboard. Every query joins the
 * customer and appends scopeFilter() — invoices, payments, promises, activities and cases are
 * visible exactly when their customer is (OWN / TEAM / ORGANIZATION). Amounts are decimal strings
 * (numeric from the database, rule 18); totals are in the tenant's reporting currency through
 * invoice_positions / fx_convert() (migration 014). Definitions: docs/metrics.md.
 */

const viewer = (ctx: TenantContext, scope: Scope) => ({ userId: ctx.userId, scope });

// ---------------------------------------------------------------------------------------------
// Customer list
// ---------------------------------------------------------------------------------------------

export const customerListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  overdue: z.enum(['1']).optional(),
  owner: z.enum(['me', 'none']).optional(),
  status: z.enum(['active', 'inactive', 'blocked']).optional(),
});
export type CustomerListQuery = z.infer<typeof customerListQuery>;

export type CustomerRow = {
  id: string;
  displayName: string | null;
  isNaturalPerson: boolean;
  taxId: string | null;
  externalId: string | null;
  status: string;
  ownerName: string | null;
  exposure: string;
  overdue: string;
  oldestDaysOverdue: number;
  missingFx: number;
  currency: string;
  /** Latest risk band (4.3), null = not scored yet. */
  riskBand: 'green' | 'yellow' | 'red' | null;
};

export async function listReceivableCustomers(
  ctx: TenantContext,
  query: CustomerListQuery,
  limit = 200,
): Promise<CustomerRow[]> {
  const { scope } = await ctx.requirePermission('customer.read');
  const params: unknown[] = [limit];
  const where: string[] = [];
  if (query.q) {
    params.push(`%${query.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
    const p = `$${params.length}`;
    where.push(`(c.display_name ILIKE ${p} OR le.tax_id ILIKE ${p} OR c.external_id ILIKE ${p})`);
  }
  if (query.status) {
    params.push(query.status);
    where.push(`c.status = $${params.length}`);
  }
  if (query.owner === 'me') {
    params.push(ctx.userId);
    where.push(`c.owner_user_id = $${params.length}::uuid`);
  } else if (query.owner === 'none') {
    where.push('c.owner_user_id IS NULL');
  }
  if (query.overdue) where.push('coalesce(agg.overdue, 0) > 0');
  const filter = scopeFilter('customers', viewer(ctx, scope), 'c', params.length + 1);
  const { rows } = await ctx.db.query<{
    id: string;
    display_name: string | null;
    is_natural_person: boolean;
    tax_id: string | null;
    external_id: string | null;
    status: string;
    owner_name: string | null;
    exposure: string | null;
    overdue: string | null;
    oldest: number | null;
    missing_fx: number | null;
    currency: string;
    risk_band: CustomerRow['riskBand'];
  }>(
    `SELECT c.id, c.display_name, c.is_natural_person, le.tax_id, c.external_id, c.status,
            u.display_name AS owner_name, agg.exposure, agg.overdue, agg.oldest, agg.missing_fx,
            coalesce(ts.default_currency, 'EUR') AS currency,
            (SELECT s.band FROM risk_scores s WHERE s.customer_id = c.id ORDER BY s.computed_at DESC LIMIT 1) AS risk_band
     FROM customers c
     LEFT JOIN tenant_settings ts ON true
     LEFT JOIN legal_entities le ON le.id = c.legal_entity_id
     LEFT JOIN users u ON u.id = c.owner_user_id
     LEFT JOIN LATERAL (
       SELECT sum(p.open_reporting) FILTER (WHERE p.is_open) AS exposure,
              sum(p.open_reporting) FILTER (WHERE p.is_overdue) AS overdue,
              max(p.days_overdue) FILTER (WHERE p.is_overdue) AS oldest,
              count(*) FILTER (WHERE p.is_open AND p.open_reporting IS NULL)::int AS missing_fx
       FROM invoice_positions p WHERE p.customer_id = c.id
     ) agg ON true
     WHERE ${filter.sql} ${where.length ? `AND ${where.join(' AND ')}` : ''}
     ORDER BY coalesce(agg.overdue, 0) DESC, coalesce(agg.exposure, 0) DESC, c.display_name NULLS LAST, c.id
     LIMIT $1`,
    [...params, ...filter.params],
  );
  return rows.map((r) => ({
    id: r.id,
    displayName: r.display_name,
    isNaturalPerson: r.is_natural_person,
    taxId: r.is_natural_person ? null : r.tax_id,
    externalId: r.external_id,
    status: r.status,
    ownerName: r.owner_name,
    exposure: r.exposure ?? '0.00',
    overdue: r.overdue ?? '0.00',
    oldestDaysOverdue: r.oldest ?? 0,
    missingFx: r.missing_fx ?? 0,
    currency: r.currency,
    riskBand: r.risk_band,
  }));
}

// ---------------------------------------------------------------------------------------------
// Saved filters (private to the user)
// ---------------------------------------------------------------------------------------------

export const savedFilterSchema = z.object({
  name: z.string().trim().min(1).max(80),
  filter: customerListQuery,
});

export async function listSavedFilters(ctx: TenantContext) {
  await ctx.requirePermission('customer.read');
  const { rows } = await ctx.db.query<{ id: string; name: string; filter: CustomerListQuery }>(
    `SELECT id, name, filter FROM saved_filters WHERE user_id = $1 AND entity = 'customers'
     ORDER BY lower(name)`,
    [ctx.userId],
  );
  return rows;
}

export async function saveFilter(ctx: TenantContext, input: z.input<typeof savedFilterSchema>) {
  await ctx.requirePermission('customer.read');
  const data = savedFilterSchema.parse(input);
  const { rows } = await ctx.db.query<{ id: string }>(
    `INSERT INTO saved_filters (tenant_id, user_id, entity, name, filter, created_by, updated_by)
     VALUES (app_tenant_id(), $1, 'customers', $2, $3, $1, $1)
     ON CONFLICT (tenant_id, user_id, entity, name) DO UPDATE SET filter = EXCLUDED.filter, updated_by = $1
     RETURNING id`,
    [ctx.userId, data.name, data.filter],
  );
  const id = rows[0]?.id ?? '';
  await ctx.audit({
    action: 'saved_filter.saved',
    entityType: 'saved_filters',
    entityId: id,
    after: { entity: 'customers' },
  });
  return { id };
}

export async function deleteSavedFilter(ctx: TenantContext, id: string) {
  await ctx.requirePermission('customer.read');
  const res = await ctx.db.query('DELETE FROM saved_filters WHERE id = $1 AND user_id = $2', [
    id,
    ctx.userId,
  ]);
  if (!res.rowCount) throw new NotFoundError();
  await ctx.audit({ action: 'saved_filter.deleted', entityType: 'saved_filters', entityId: id });
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// Customer 360
// ---------------------------------------------------------------------------------------------

export type AgingRow = { bucket: string; amount: string; count: number };

export type Customer360 = {
  id: string;
  displayName: string | null;
  isNaturalPerson: boolean;
  taxId: string | null;
  status: string;
  ownerName: string | null;
  currency: string;
  exposure: string;
  overdue: string;
  oldestDaysOverdue: number;
  missingFx: number;
  openPromises: number;
  openCases: number;
  aging: AgingRow[];
  companyId: string | null;
};

/** The customer within scope or 404 — the gate for every tab below. */
async function scopedCustomer(ctx: TenantContext, customerId: string, permission: string) {
  const { scope } = await ctx.requirePermission(permission);
  const filter = scopeFilter('customers', viewer(ctx, scope), 'c', 2);
  const { rows } = await ctx.db.query<{ id: string }>(
    `SELECT c.id FROM customers c WHERE c.id = $1 AND ${filter.sql}`,
    [customerId, ...filter.params],
  );
  if (!rows[0]) throw new NotFoundError();
}

export async function getCustomer360(
  ctx: TenantContext,
  customerId: string,
  keyring: MasterKeyring = getMasterKeyring(),
): Promise<Customer360> {
  await scopedCustomer(ctx, customerId, 'customer.read');
  const { rows } = await ctx.db.query<{
    id: string;
    display_name: string | null;
    is_natural_person: boolean;
    tax_id: string | null;
    status: string;
    owner_name: string | null;
    currency: string;
    company_id: string | null;
  }>(
    `SELECT c.id, c.display_name, c.is_natural_person, le.tax_id, c.status, u.display_name AS owner_name,
            coalesce(ts.default_currency, 'EUR') AS currency,
            (SELECT tc.id FROM tenant_companies tc ORDER BY tc.is_default DESC, tc.created_at LIMIT 1) AS company_id
     FROM customers c LEFT JOIN tenant_settings ts ON true
     LEFT JOIN legal_entities le ON le.id = c.legal_entity_id
     LEFT JOIN users u ON u.id = c.owner_user_id
     WHERE c.id = $1`,
    [customerId],
  );
  const c = rows[0];
  if (!c) throw new NotFoundError();
  const totals = await ctx.db.query<{
    exposure: string | null;
    overdue: string | null;
    oldest: number | null;
    missing_fx: number;
  }>(
    `SELECT sum(open_reporting) FILTER (WHERE is_open) AS exposure,
            sum(open_reporting) FILTER (WHERE is_overdue) AS overdue,
            max(days_overdue) FILTER (WHERE is_overdue) AS oldest,
            count(*) FILTER (WHERE is_open AND open_reporting IS NULL)::int AS missing_fx
     FROM invoice_positions WHERE customer_id = $1`,
    [customerId],
  );
  const aging = await ctx.db.query<{ bucket: string; amount: string | null; n: number }>(
    `SELECT b.code AS bucket, sum(p.open_reporting) AS amount, count(p.invoice_id)::int AS n
     FROM aging_bucket_bounds b
     LEFT JOIN invoice_positions p ON p.aging_bucket = b.code AND p.customer_id = $1 AND p.is_open
     GROUP BY b.code, b.min_days_overdue ORDER BY b.min_days_overdue`,
    [customerId],
  );
  const counts = await ctx.db.query<{ promises: number; cases: number }>(
    `SELECT (SELECT count(*) FROM promises WHERE customer_id = $1 AND status = 'pending')::int AS promises,
            (SELECT count(*) FROM collection_cases WHERE customer_id = $1 AND status = 'open')::int AS cases`,
    [customerId],
  );
  const name = c.is_natural_person
    ? ((await readCustomerName(ctx.db, keyring, customerId)) ?? null)
    : c.display_name;
  const t = totals.rows[0];
  return {
    id: c.id,
    displayName: name,
    isNaturalPerson: c.is_natural_person,
    taxId: c.is_natural_person ? null : c.tax_id,
    status: c.status,
    ownerName: c.owner_name,
    currency: c.currency,
    exposure: t?.exposure ?? '0.00',
    overdue: t?.overdue ?? '0.00',
    oldestDaysOverdue: t?.oldest ?? 0,
    missingFx: t?.missing_fx ?? 0,
    openPromises: counts.rows[0]?.promises ?? 0,
    openCases: counts.rows[0]?.cases ?? 0,
    aging: aging.rows.map((a) => ({ bucket: a.bucket, amount: a.amount ?? '0.00', count: a.n })),
    companyId: c.company_id,
  };
}

export type InvoiceRow = {
  id: string;
  number: string;
  issueDate: string;
  dueDate: string;
  currency: string;
  amountTotal: string;
  amountOpen: string;
  status: string;
  daysOverdue: number;
  isOverdue: boolean;
  bucket: string | null;
};

export async function customerInvoices(
  ctx: TenantContext,
  customerId: string,
): Promise<InvoiceRow[]> {
  await scopedCustomer(ctx, customerId, 'invoice.read');
  const { rows } = await ctx.db.query<{
    invoice_id: string;
    number: string;
    issue_date: string;
    due_date: string;
    currency: string;
    amount_total: string;
    amount_open: string;
    accounting_status: string;
    days_overdue: number;
    is_overdue: boolean;
    aging_bucket: string | null;
  }>(
    `SELECT invoice_id, number, issue_date::text, due_date::text, currency, amount_total, amount_open,
            accounting_status, days_overdue, is_overdue, aging_bucket
     FROM invoice_positions WHERE customer_id = $1
     ORDER BY is_open DESC, due_date, number`,
    [customerId],
  );
  return rows.map((r) => ({
    id: r.invoice_id,
    number: r.number,
    issueDate: r.issue_date,
    dueDate: r.due_date,
    currency: r.currency,
    amountTotal: r.amount_total,
    amountOpen: r.amount_open,
    status: r.accounting_status,
    daysOverdue: r.days_overdue,
    isOverdue: r.is_overdue,
    bucket: r.aging_bucket,
  }));
}

export type PaymentRow = {
  id: string;
  paidOn: string;
  amount: string;
  currency: string;
  /** 'payment' = money received; 'adjustment' = lowered without money (never "collected"). */
  kind: 'payment' | 'adjustment';
  /** Adjustment reason code (code list 'adjustment_reason'); null for payments. */
  reason: string | null;
  reference: string | null;
  allocated: string;
};

export async function customerPayments(
  ctx: TenantContext,
  customerId: string,
): Promise<PaymentRow[]> {
  await scopedCustomer(ctx, customerId, 'payment.read');
  const { rows } = await ctx.db.query<{
    id: string;
    paid_on: string;
    amount: string;
    currency: string;
    kind: 'payment' | 'adjustment';
    reason: string | null;
    reference: string | null;
    allocated: string;
  }>(
    `SELECT p.id, p.paid_on::text, p.amount, p.currency, p.payment_kind AS kind,
            CASE WHEN p.payment_kind = 'adjustment' THEN coalesce(p.adjustment_reason_code, 'unknown') END AS reason,
            p.reference,
            coalesce((SELECT sum(a.amount) FROM payment_allocations a WHERE a.payment_id = p.id), 0)::numeric(18,2)::text AS allocated
     FROM payments p WHERE p.customer_id = $1 ORDER BY p.paid_on DESC, p.created_at DESC`,
    [customerId],
  );
  return rows.map((r) => ({
    id: r.id,
    paidOn: r.paid_on,
    amount: r.amount,
    currency: r.currency,
    kind: r.kind,
    reason: r.reason,
    reference: r.reference,
    allocated: r.allocated,
  }));
}

export type PromiseRow = {
  id: string;
  amount: string;
  currency: string;
  promisedOn: string;
  madeOn: string;
  status: string;
  paidAmount: string | null;
  caseId: string | null;
};

export async function customerPromises(
  ctx: TenantContext,
  customerId: string,
): Promise<PromiseRow[]> {
  await scopedCustomer(ctx, customerId, 'promise.read');
  const { rows } = await ctx.db.query<{
    id: string;
    amount: string;
    currency: string;
    promised_on: string;
    made_on: string;
    status: string;
    paid_amount: string | null;
    case_id: string | null;
  }>(
    `SELECT id, amount, currency, promised_on::text, made_on::text, status, paid_amount, case_id
     FROM promises WHERE customer_id = $1 ORDER BY (status = 'pending') DESC, promised_on DESC`,
    [customerId],
  );
  return rows.map((r) => ({
    id: r.id,
    amount: r.amount,
    currency: r.currency,
    promisedOn: r.promised_on,
    madeOn: r.made_on,
    status: r.status,
    paidAmount: r.paid_amount,
    caseId: r.case_id,
  }));
}

export type ActivityRow = {
  id: string;
  kind: string;
  outcome: string | null;
  nextAction: string | null;
  nextActionOn: string | null;
  note: string | null;
  occurredAt: string;
  actorName: string;
  caseId: string | null;
};

export async function customerActivities(
  ctx: TenantContext,
  customerId: string,
  keyring: MasterKeyring = getMasterKeyring(),
  caseId?: string,
): Promise<ActivityRow[]> {
  await scopedCustomer(ctx, customerId, 'activity.read');
  const { rows } = await ctx.db.query<{
    id: string;
    kind: string;
    outcome_code: string | null;
    next_action_code: string | null;
    next_action_on: string | null;
    note_enc: Buffer | null;
    note_key_version: number | null;
    occurred_at: Date;
    actor_name: string;
    case_id: string | null;
  }>(
    `SELECT a.id, a.kind, a.outcome_code, a.next_action_code, a.next_action_on::text, a.note_enc,
            a.note_key_version, a.occurred_at, u.display_name AS actor_name, a.case_id
     FROM activities a JOIN users u ON u.id = a.actor_user_id
     WHERE a.customer_id = $1 AND ($2::uuid IS NULL OR a.case_id = $2)
     ORDER BY a.occurred_at DESC LIMIT 200`,
    [customerId, caseId ?? null],
  );
  return Promise.all(
    rows.map(async (r) => ({
      id: r.id,
      kind: r.kind,
      outcome: r.outcome_code,
      nextAction: r.next_action_code,
      nextActionOn: r.next_action_on,
      note:
        r.note_enc && r.note_key_version !== null
          ? await decryptField(
              ctx.db,
              keyring,
              { type: 'customer', id: customerId },
              { table: 'activities', column: 'note_enc', rowId: r.id },
              { ciphertext: r.note_enc, keyVersion: r.note_key_version },
            )
          : null,
      occurredAt: r.occurred_at.toISOString(),
      actorName: r.actor_name,
      caseId: r.case_id,
    })),
  );
}

export type CaseRow = {
  id: string;
  stage: string;
  status: string;
  priority: string;
  ownerName: string | null;
  openedAt: string;
  invoices: number;
  amountOpen: string;
};

export async function customerCases(ctx: TenantContext, customerId: string): Promise<CaseRow[]> {
  await scopedCustomer(ctx, customerId, 'case.read');
  const { rows } = await ctx.db.query<{
    id: string;
    stage_code: string;
    status: string;
    priority: string;
    owner_name: string | null;
    opened_at: Date;
    invoices: number;
    amount_open: string | null;
  }>(
    `SELECT k.id, k.stage_code, k.status, k.priority, u.display_name AS owner_name, k.opened_at,
            count(ci.id)::int AS invoices, sum(p.open_reporting) AS amount_open
     FROM collection_cases k
     LEFT JOIN users u ON u.id = k.owner_user_id
     LEFT JOIN case_invoices ci ON ci.case_id = k.id
     LEFT JOIN invoice_positions p ON p.invoice_id = ci.invoice_id
     WHERE k.customer_id = $1
     GROUP BY k.id, u.display_name ORDER BY (k.status = 'open') DESC, k.opened_at DESC`,
    [customerId],
  );
  return rows.map((r) => ({
    id: r.id,
    stage: r.stage_code,
    status: r.status,
    priority: r.priority,
    ownerName: r.owner_name,
    openedAt: r.opened_at.toISOString(),
    invoices: r.invoices,
    amountOpen: r.amount_open ?? '0.00',
  }));
}

// ---------------------------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------------------------

export type Dashboard = {
  currency: string;
  openTotal: string;
  overdueTotal: string;
  dso: string | null;
  dsoWindowDays: number;
  /** Money received in the last 30 days (payments only — adjustments never count). */
  collected30: string;
  /** collected30 ÷ (collected30 + overdue total) in %, one decimal; null without both. */
  collectionRate: string | null;
  promisesToday: { count: number; amount: string };
  promisesBroken: number;
  openCases: number;
  missingFx: number;
  aging: AgingRow[];
  topOverdue: {
    id: string;
    displayName: string | null;
    overdue: string;
    oldestDaysOverdue: number;
  }[];
};

export async function getDashboard(ctx: TenantContext): Promise<Dashboard> {
  const { scope } = await ctx.requirePermission('report.read');
  const filter = scopeFilter('customers', viewer(ctx, scope), 'c', 1);
  const scoped = `JOIN customers c ON c.id = p.customer_id AND ${filter.sql}`;
  const totals = await ctx.db.query<{
    currency: string;
    open_total: string | null;
    overdue_total: string | null;
    billed: string | null;
    dso_open: string | null;
    window_days: number;
    missing_fx: number;
  }>(
    `SELECT ts.default_currency AS currency, ts.dso_window_days AS window_days,
            sum(p.open_reporting) FILTER (WHERE p.is_open) AS open_total,
            sum(p.dso_open_reporting) AS dso_open,
            sum(p.open_reporting) FILTER (WHERE p.is_overdue) AS overdue_total,
            sum(p.total_reporting) FILTER (WHERE p.issue_date > p.local_today - ts.dso_window_days
                                             AND p.accounting_status <> 'cancelled') AS billed,
            count(*) FILTER (WHERE p.is_open AND p.open_reporting IS NULL)::int AS missing_fx
     FROM tenant_settings ts
     LEFT JOIN (invoice_positions p ${scoped}) ON true
     GROUP BY ts.default_currency, ts.dso_window_days`,
    filter.params,
  );
  const t = totals.rows[0];
  // DSO = open (adjustments added back — they are not collection) / (billed in the window /
  // window days), in numeric — never a float.
  const dso = await ctx.db.query<{ dso: string | null }>(
    `SELECT CASE WHEN $2::numeric > 0 THEN round($1::numeric / ($2::numeric / $3::int), 1)::text END AS dso`,
    [t?.dso_open ?? '0', t?.billed ?? '0', t?.window_days ?? 90],
  );
  const collected = await ctx.db.query<{ collected: string | null; rate: string | null }>(
    `WITH c30 AS (
       SELECT sum(fx_convert(py.amount, py.currency, ts.default_currency, py.paid_on)) AS amount
       FROM payments py
       JOIN customers c ON c.id = py.customer_id AND ${filter.sql}
       CROSS JOIN tenant_settings ts
       WHERE py.payment_kind = 'payment'
         AND py.paid_on > (now() AT TIME ZONE ts.timezone)::date - 30)
     SELECT coalesce(amount, 0)::numeric(18,2)::text AS collected,
            CASE WHEN coalesce(amount, 0) + $${filter.params.length + 1}::numeric > 0
                 THEN round(coalesce(amount, 0) * 100 / (coalesce(amount, 0) + $${filter.params.length + 1}::numeric), 1)::text
            END AS rate
     FROM c30`,
    [...filter.params, t?.overdue_total ?? '0'],
  );
  const aging = await ctx.db.query<{ bucket: string; amount: string | null; n: number }>(
    `SELECT b.code AS bucket, sum(x.open_reporting) AS amount, count(x.invoice_id)::int AS n
     FROM aging_bucket_bounds b
     LEFT JOIN (SELECT p.* FROM invoice_positions p ${scoped} WHERE p.is_open) x ON x.aging_bucket = b.code
     GROUP BY b.code, b.min_days_overdue ORDER BY b.min_days_overdue`,
    filter.params,
  );
  const promises = await ctx.db.query<{
    today_n: number;
    today_amount: string | null;
    broken: number;
  }>(
    `SELECT count(*) FILTER (WHERE pr.status = 'pending' AND pr.promised_on = d.local_today)::int AS today_n,
            sum(pr.amount) FILTER (WHERE pr.status = 'pending' AND pr.promised_on = d.local_today) AS today_amount,
            count(*) FILTER (WHERE pr.status = 'broken' AND pr.promised_on > d.local_today - 30)::int AS broken
     FROM promises pr
     JOIN customers c ON c.id = pr.customer_id AND ${filter.sql}
     JOIN tenant_companies tc ON tc.id = pr.company_id
     JOIN legal_entities le ON le.id = tc.legal_entity_id
     CROSS JOIN LATERAL (SELECT (now() AT TIME ZONE le.timezone)::date AS local_today) d`,
    filter.params,
  );
  const cases = await ctx.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM collection_cases k JOIN customers c ON c.id = k.customer_id AND ${filter.sql}
     WHERE k.status = 'open'`,
    filter.params,
  );
  const top = await ctx.db.query<{
    id: string;
    display_name: string | null;
    overdue: string;
    oldest: number;
  }>(
    `SELECT c.id, c.display_name, sum(p.open_reporting) AS overdue, max(p.days_overdue) AS oldest
     FROM invoice_positions p ${scoped}
     WHERE p.is_overdue GROUP BY c.id, c.display_name
     HAVING sum(p.open_reporting) > 0
     ORDER BY sum(p.open_reporting) DESC LIMIT 5`,
    filter.params,
  );
  const pr = promises.rows[0];
  return {
    currency: t?.currency ?? 'EUR',
    openTotal: t?.open_total ?? '0.00',
    overdueTotal: t?.overdue_total ?? '0.00',
    dso: dso.rows[0]?.dso ?? null,
    dsoWindowDays: t?.window_days ?? 90,
    collected30: collected.rows[0]?.collected ?? '0.00',
    collectionRate: collected.rows[0]?.rate ?? null,
    promisesToday: { count: pr?.today_n ?? 0, amount: pr?.today_amount ?? '0.00' },
    promisesBroken: pr?.broken ?? 0,
    openCases: cases.rows[0]?.n ?? 0,
    missingFx: t?.missing_fx ?? 0,
    aging: aging.rows.map((a) => ({ bucket: a.bucket, amount: a.amount ?? '0.00', count: a.n })),
    topOverdue: top.rows.map((r) => ({
      id: r.id,
      displayName: r.display_name,
      overdue: r.overdue,
      oldestDaysOverdue: r.oldest,
    })),
  };
}

export type WorkItem = {
  kind: 'promise_due' | 'next_action' | 'case';
  customerId: string;
  customerName: string | null;
  refId: string;
  date: string | null;
  code: string | null;
  amount: string | null;
  currency: string | null;
};

/**
 * "My work today": promises due today, next actions due (today or earlier), open cases — for
 * the customers I own (OWN) or my team's (TEAM, only when the grant allows TEAM or wider).
 */
export async function myWorkToday(ctx: TenantContext, mode: 'own' | 'team'): Promise<WorkItem[]> {
  const grant = await ctx.requirePermission('report.read');
  const scope: Scope = mode === 'team' && grant.scope !== 'OWN' ? 'TEAM' : 'OWN';
  const filter = scopeFilter('customers', viewer(ctx, scope), 'c', 1);
  const { rows } = await ctx.db.query<{
    kind: WorkItem['kind'];
    customer_id: string;
    customer_name: string | null;
    ref_id: string;
    date: string | null;
    code: string | null;
    amount: string | null;
    currency: string | null;
  }>(
    `WITH mine AS (SELECT c.id, c.display_name FROM customers c WHERE ${filter.sql}),
          today AS (SELECT (now() AT TIME ZONE le.timezone)::date AS d
                    FROM tenant_companies tc JOIN legal_entities le ON le.id = tc.legal_entity_id
                    ORDER BY tc.is_default DESC, tc.created_at LIMIT 1)
     SELECT 'promise_due' AS kind, m.id AS customer_id, m.display_name AS customer_name, pr.id AS ref_id,
            pr.promised_on::text AS date, NULL AS code, pr.amount, pr.currency
     FROM promises pr JOIN mine m ON m.id = pr.customer_id, today
     WHERE pr.status = 'pending' AND pr.promised_on <= today.d
     UNION ALL
     SELECT 'next_action', m.id, m.display_name, a.id, a.next_action_on::text, a.next_action_code, NULL, NULL
     FROM activities a JOIN mine m ON m.id = a.customer_id, today
     WHERE a.next_action_on <= today.d
       AND NOT EXISTS (SELECT 1 FROM activities later
                       WHERE later.customer_id = a.customer_id AND later.occurred_at > a.occurred_at)
     UNION ALL
     SELECT 'case', m.id, m.display_name, k.id, k.opened_at::date::text, k.stage_code, NULL, NULL
     FROM collection_cases k JOIN mine m ON m.id = k.customer_id
     WHERE k.status = 'open'
     ORDER BY 1, 5 NULLS LAST
     LIMIT 100`,
    filter.params,
  );
  return rows.map((r) => ({
    kind: r.kind,
    customerId: r.customer_id,
    customerName: r.customer_name,
    refId: r.ref_id,
    date: r.date,
    code: r.code,
    amount: r.amount,
    currency: r.currency,
  }));
}

/** Labels of a tenant code list in a locale (translations; falls back to the code). */
export async function codeLabels(
  ctx: TenantContext,
  listKey: string,
  locale: string,
): Promise<Record<string, string>> {
  const { rows } = await ctx.db.query<{ code: string; text: string | null }>(
    `SELECT cl.code, coalesce(t1.text, t2.text) AS text
     FROM code_lists cl
     LEFT JOIN translations t1 ON t1.entity_type = 'code_list' AND t1.entity_key = cl.list_key || '.' || cl.code
                              AND t1.field = 'name' AND t1.locale = $2
     LEFT JOIN translations t2 ON t2.entity_type = 'code_list' AND t2.entity_key = cl.list_key || '.' || cl.code
                              AND t2.field = 'name' AND t2.locale = 'sr-Latn'
     WHERE cl.list_key = $1 AND cl.is_active
     ORDER BY cl.sort_order, cl.code`,
    [listKey, locale],
  );
  return Object.fromEntries(rows.map((r) => [r.code, r.text ?? r.code]));
}
