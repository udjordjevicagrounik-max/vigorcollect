import { z } from 'zod';
import type { Scope } from '@/server/auth/permissions';
import { scopeFilter } from '@/server/auth/scope';
import { NotFoundError, type TenantContext } from '@/server/auth/with-tenant';

/**
 * The six base reports (5.2), definitions in docs/metrics.md ("Izveštaji"). Every figure is in the
 * reporting currency through invoice_positions / fx_convert(), limited to the customers the member
 * sees (scopeFilter, OWN / TEAM / ORGANIZATION). Amounts stay decimal strings (rule 18).
 * A report = typed columns + rows; the screen and exportService (CSV / XLSX) use the same result.
 */

export const REPORT_KEYS = [
  'aging_by_customer',
  'aging_by_collector',
  'collected_by_period',
  'promises',
  'cases_by_stage',
  'disputes',
] as const;
export type ReportKey = (typeof REPORT_KEYS)[number];

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const reportFilters = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  owner: z.enum(['me']).optional(),
  teamId: z.uuid().optional(),
  groupBy: z.enum(['owner', 'team']).optional(),
  period: z.enum(['day', 'week', 'month']).optional(),
});
export type ReportFilters = z.infer<typeof reportFilters>;

export const reportConfig = z.object({
  filters: reportFilters.default({}),
  /** Visible columns (keys); empty = all. */
  columns: z
    .array(z.string().regex(/^[a-z][a-z0-9_]{0,62}$/))
    .max(40)
    .default([]),
  sort: z
    .object({ column: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/), dir: z.enum(['asc', 'desc']) })
    .optional(),
});
export type ReportConfig = z.infer<typeof reportConfig>;

export type ColumnType = 'text' | 'amount' | 'int' | 'date';
/** `label` set = a tenant code (bucket / stage / reason) — shown as is; else reports.columns.<key>. */
export type ReportColumn = { key: string; type: ColumnType; label?: string };
export type ReportRow = Record<string, string | number | null>;
export type ReportResult = {
  key: ReportKey;
  currency: string;
  columns: ReportColumn[];
  rows: ReportRow[];
};

export const REPORT_ROW_LIMIT = 5000;

type Viewer = { userId: string; scope: Scope };

/** customers alias c: scope + optional owner / team filter. Returns SQL and its params. */
function customerWhere(viewer: Viewer, filters: ReportFilters, nextParam: number) {
  const f = scopeFilter('customers', viewer, 'c', nextParam);
  const parts = [f.sql];
  const params = [...f.params];
  if (filters.owner === 'me') {
    params.push(viewer.userId);
    parts.push(`c.owner_user_id = $${nextParam + params.length - 1}::uuid`);
  }
  if (filters.teamId) {
    params.push(filters.teamId);
    parts.push(`c.owner_team_id = $${nextParam + params.length - 1}::uuid`);
  }
  return { sql: parts.join(' AND '), params };
}

async function currency(ctx: TenantContext): Promise<string> {
  const { rows } = await ctx.db.query<{ c: string }>(
    `SELECT coalesce((SELECT default_currency FROM tenant_settings), 'EUR') AS c`,
  );
  return rows[0]?.c ?? 'EUR';
}

async function buckets(ctx: TenantContext): Promise<string[]> {
  const { rows } = await ctx.db.query<{ code: string }>(
    'SELECT code FROM aging_bucket_bounds ORDER BY min_days_overdue',
  );
  return rows.map((r) => r.code);
}

/** Default period: the last 90 days up to today (tenant zone). */
async function period(ctx: TenantContext, filters: ReportFilters): Promise<[string, string]> {
  const { rows } = await ctx.db.query<{ from: string; to: string }>(
    `SELECT coalesce($1::date, (now() AT TIME ZONE ts.timezone)::date - 90)::text AS from,
            coalesce($2::date, (now() AT TIME ZONE ts.timezone)::date)::text AS to
     FROM tenant_settings ts`,
    [filters.from ?? null, filters.to ?? null],
  );
  return [rows[0]?.from ?? '', rows[0]?.to ?? ''];
}

async function agingByCustomer(ctx: TenantContext, v: Viewer, f: ReportFilters) {
  const codes = await buckets(ctx);
  const w = customerWhere(v, f, 2);
  const { rows } = await ctx.db.query<{
    id: string;
    customer: string | null;
    owner: string | null;
    by_bucket: Record<string, string> | null;
    open_total: string | null;
    overdue_total: string | null;
    disputed: string | null;
  }>(
    `SELECT c.id, c.display_name AS customer, u.display_name AS owner,
            (SELECT jsonb_object_agg(x.bucket, x.amount) FROM (
               SELECT p.aging_bucket AS bucket, sum(p.open_reporting)::text AS amount
               FROM invoice_positions p WHERE p.customer_id = c.id AND p.is_open GROUP BY p.aging_bucket) x) AS by_bucket,
            agg.open_total, agg.overdue_total, agg.disputed
     FROM customers c
     LEFT JOIN users u ON u.id = c.owner_user_id
     JOIN LATERAL (
       SELECT sum(p.open_reporting) FILTER (WHERE p.is_open) AS open_total,
              sum(p.open_reporting) FILTER (WHERE p.is_overdue) AS overdue_total,
              sum(p.open_reporting) FILTER (WHERE p.is_open AND p.is_disputed) AS disputed
       FROM invoice_positions p WHERE p.customer_id = c.id) agg ON agg.open_total IS NOT NULL
     WHERE ${w.sql}
     ORDER BY agg.overdue_total DESC NULLS LAST, c.display_name NULLS LAST, c.id
     LIMIT $1`,
    [REPORT_ROW_LIMIT, ...w.params],
  );
  return {
    columns: [
      { key: 'customer', type: 'text' },
      { key: 'owner', type: 'text' },
      ...codes.map((code): ReportColumn => ({
        key: `bucket_${code}`,
        type: 'amount',
        label: code,
      })),
      { key: 'open_total', type: 'amount' },
      { key: 'overdue_total', type: 'amount' },
      { key: 'disputed', type: 'amount' },
    ] satisfies ReportColumn[],
    rows: rows.map((r) => ({
      customer: r.customer,
      owner: r.owner,
      ...Object.fromEntries(codes.map((code) => [`bucket_${code}`, r.by_bucket?.[code] ?? '0.00'])),
      open_total: r.open_total ?? '0.00',
      overdue_total: r.overdue_total ?? '0.00',
      disputed: r.disputed ?? '0.00',
    })),
  };
}

async function agingByCollector(ctx: TenantContext, v: Viewer, f: ReportFilters) {
  const codes = await buckets(ctx);
  const w = customerWhere(v, f, 2);
  // group column is one of two fixed expressions (never input).
  const group =
    f.groupBy === 'team'
      ? { key: 'tm.name', join: 'LEFT JOIN teams tm ON tm.id = c.owner_team_id' }
      : { key: 'u.display_name', join: 'LEFT JOIN users u ON u.id = c.owner_user_id' };
  const { rows } = await ctx.db.query<{
    owner: string | null;
    bucket: string | null;
    amount: string | null;
    customers: number;
  }>(
    `SELECT ${group.key} AS owner, p.aging_bucket AS bucket, sum(p.open_reporting)::text AS amount,
            count(DISTINCT c.id)::int AS customers
     FROM invoice_positions p JOIN customers c ON c.id = p.customer_id ${group.join}
     WHERE p.is_open AND ${w.sql}
     GROUP BY GROUPING SETS ((${group.key}, p.aging_bucket), (${group.key}))
     ORDER BY ${group.key} NULLS LAST
     LIMIT $1`,
    [REPORT_ROW_LIMIT, ...w.params],
  );
  const groupCol = f.groupBy === 'team' ? 'team' : 'owner';
  const byOwner = new Map<string, ReportRow>();
  for (const r of rows) {
    const k = r.owner ?? '';
    const row = byOwner.get(k) ?? {
      [groupCol]: r.owner,
      ...Object.fromEntries(codes.map((code) => [`bucket_${code}`, '0.00'])),
      open_total: '0.00',
      customers: 0,
    };
    if (r.bucket === null) {
      row.open_total = r.amount ?? '0.00';
      row.customers = r.customers;
    } else row[`bucket_${r.bucket}`] = r.amount ?? '0.00';
    byOwner.set(k, row);
  }
  return {
    columns: [
      { key: groupCol, type: 'text' },
      ...codes.map((code): ReportColumn => ({
        key: `bucket_${code}`,
        type: 'amount',
        label: code,
      })),
      { key: 'open_total', type: 'amount' },
      { key: 'customers', type: 'int' },
    ] satisfies ReportColumn[],
    rows: [...byOwner.values()],
  };
}

async function collectedByPeriod(ctx: TenantContext, v: Viewer, f: ReportFilters) {
  const [from, to] = await period(ctx, f);
  const unit = f.period ?? 'month';
  const w = customerWhere(v, f, 5);
  const { rows } = await ctx.db.query<{ period: string; collected: string; payments: number }>(
    `SELECT date_trunc($3, py.paid_on)::date::text AS period,
            coalesce(sum(fx_convert(py.amount, py.currency, ts.default_currency, py.paid_on)), 0)::numeric(18,2)::text AS collected,
            count(*)::int AS payments
     FROM payments py JOIN customers c ON c.id = py.customer_id CROSS JOIN tenant_settings ts
     WHERE py.payment_kind = 'payment' AND py.paid_on BETWEEN $1::date AND $2::date AND ${w.sql}
     GROUP BY 1 ORDER BY 1 LIMIT $4`,
    [from, to, unit, REPORT_ROW_LIMIT, ...w.params],
  );
  return {
    columns: [
      { key: 'period', type: 'date' },
      { key: 'collected', type: 'amount' },
      { key: 'payments', type: 'int' },
    ] satisfies ReportColumn[],
    rows,
  };
}

async function promisesReport(ctx: TenantContext, v: Viewer, f: ReportFilters) {
  const [from, to] = await period(ctx, f);
  const w = customerWhere(v, f, 4);
  const { rows } = await ctx.db.query<{
    status: string;
    promises: number;
    amount: string;
    paid: string;
  }>(
    `SELECT pr.status, count(*)::int AS promises,
            coalesce(sum(fx_convert(pr.amount, pr.currency, ts.default_currency, pr.promised_on)), 0)::numeric(18,2)::text AS amount,
            coalesce(sum(fx_convert(coalesce(pr.paid_amount, 0), pr.currency, ts.default_currency, pr.promised_on)), 0)::numeric(18,2)::text AS paid
     FROM promises pr JOIN customers c ON c.id = pr.customer_id CROSS JOIN tenant_settings ts
     WHERE pr.promised_on BETWEEN $1::date AND $2::date AND pr.status <> 'cancelled' AND ${w.sql}
     GROUP BY pr.status
     ORDER BY array_position(ARRAY['fulfilled', 'partial', 'broken', 'pending'], pr.status)
     LIMIT $3`,
    [from, to, REPORT_ROW_LIMIT, ...w.params],
  );
  return {
    columns: [
      { key: 'status', type: 'text' },
      { key: 'promises', type: 'int' },
      { key: 'amount', type: 'amount' },
      { key: 'paid', type: 'amount' },
    ] satisfies ReportColumn[],
    rows,
  };
}

async function casesByStage(ctx: TenantContext, v: Viewer, f: ReportFilters) {
  const w = customerWhere(v, f, 2);
  const { rows } = await ctx.db.query<{
    stage: string;
    cases: number;
    open_amount: string;
    avg_age_days: number;
  }>(
    `SELECT k.stage_code AS stage, count(*)::int AS cases,
            coalesce(sum(x.amount), 0)::numeric(18,2)::text AS open_amount,
            round(avg(extract(epoch FROM now() - k.opened_at) / 86400))::int AS avg_age_days
     FROM collection_cases k JOIN customers c ON c.id = k.customer_id
     LEFT JOIN LATERAL (SELECT sum(p.open_reporting) AS amount FROM case_invoices ci
                        JOIN invoice_positions p ON p.invoice_id = ci.invoice_id
                        WHERE ci.case_id = k.id AND p.is_open) x ON true
     WHERE k.status = 'open' AND ${w.sql}
     GROUP BY k.stage_code ORDER BY count(*) DESC, k.stage_code LIMIT $1`,
    [REPORT_ROW_LIMIT, ...w.params],
  );
  return {
    columns: [
      { key: 'stage', type: 'text' },
      { key: 'cases', type: 'int' },
      { key: 'open_amount', type: 'amount' },
      { key: 'avg_age_days', type: 'int' },
    ] satisfies ReportColumn[],
    rows,
  };
}

async function disputesReport(ctx: TenantContext, v: Viewer, f: ReportFilters) {
  const [from, to] = await period(ctx, f);
  const w = customerWhere(v, f, 4);
  const { rows } = await ctx.db.query<{
    reason: string;
    status: string;
    disputes: number;
    amount: string;
    avg_days_open: number;
  }>(
    `SELECT d.reason_code AS reason, d.status, count(*)::int AS disputes,
            coalesce(sum(x.amount), 0)::numeric(18,2)::text AS amount,
            round(avg(extract(epoch FROM coalesce(d.resolved_at, now()) - d.opened_at) / 86400))::int AS avg_days_open
     FROM disputes d JOIN customers c ON c.id = d.customer_id
     LEFT JOIN LATERAL (SELECT sum(p.open_reporting) AS amount FROM dispute_invoices di
                        JOIN invoice_positions p ON p.invoice_id = di.invoice_id
                        WHERE di.dispute_id = d.id) x ON true
     WHERE (d.opened_at AT TIME ZONE 'UTC')::date BETWEEN $1::date AND $2::date AND ${w.sql}
     GROUP BY d.reason_code, d.status ORDER BY d.reason_code, d.status LIMIT $3`,
    [from, to, REPORT_ROW_LIMIT, ...w.params],
  );
  return {
    columns: [
      { key: 'reason', type: 'text' },
      { key: 'status', type: 'text' },
      { key: 'disputes', type: 'int' },
      { key: 'amount', type: 'amount' },
      { key: 'avg_days_open', type: 'int' },
    ] satisfies ReportColumn[],
    rows,
  };
}

const RUNNERS: Record<
  ReportKey,
  (
    ctx: TenantContext,
    v: Viewer,
    f: ReportFilters,
  ) => Promise<{ columns: ReportColumn[]; rows: ReportRow[] }>
> = {
  aging_by_customer: agingByCustomer,
  aging_by_collector: agingByCollector,
  collected_by_period: collectedByPeriod,
  promises: promisesReport,
  cases_by_stage: casesByStage,
  disputes: disputesReport,
};

/** Runs a report for the member (report.read + their customer scope). */
export async function runReport(
  ctx: TenantContext,
  key: ReportKey,
  input: z.input<typeof reportConfig> = {},
  permission = 'report.read',
): Promise<ReportResult> {
  const config = reportConfig.parse(input);
  const { scope } = await ctx.requirePermission(permission);
  const out = await RUNNERS[key](ctx, { userId: ctx.userId, scope }, config.filters);
  let columns = out.columns;
  let rows = out.rows;
  if (config.columns.length) {
    const keep = new Set(config.columns);
    columns = columns.filter((c, i) => i === 0 || keep.has(c.key));
  }
  if (config.sort && columns.some((c) => c.key === config.sort?.column)) {
    const { column, dir } = config.sort;
    const type = columns.find((c) => c.key === column)?.type;
    rows = [...rows].sort(
      (a, b) => compare(a[column] ?? null, b[column] ?? null, type) * (dir === 'asc' ? 1 : -1),
    );
  }
  return { key, currency: await currency(ctx), columns, rows };
}

/** Decimal strings compared without a float: sign, then integer length, then lexical. */
function compareDecimal(a: string, b: string): number {
  const neg = (s: string) => s.startsWith('-');
  if (neg(a) !== neg(b)) return neg(a) ? -1 : 1;
  const [ai = '', af = ''] = a.replace('-', '').split('.');
  const [bi = '', bf = ''] = b.replace('-', '').split('.');
  const mag =
    ai.length !== bi.length
      ? ai.length - bi.length
      : ai.localeCompare(bi) || af.padEnd(10, '0').localeCompare(bf.padEnd(10, '0'));
  return neg(a) ? -mag : mag;
}

function compare(a: string | number | null, b: string | number | null, type?: ColumnType): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  if (type === 'amount') return compareDecimal(String(a), String(b));
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

// ---------------------------------------------------------------------------------------------
// Saved reports
// ---------------------------------------------------------------------------------------------

export const savedReportSchema = z.object({
  reportKey: z.enum(REPORT_KEYS),
  name: z.string().trim().min(1).max(120),
  config: reportConfig,
  shared: z.boolean().default(false),
});

export type SavedReport = {
  id: string;
  reportKey: ReportKey;
  name: string;
  config: ReportConfig;
  shared: boolean;
  mine: boolean;
};

/** Own saved reports + those shared in the tenant. */
export async function listSavedReports(ctx: TenantContext): Promise<SavedReport[]> {
  await ctx.requirePermission('report.read');
  const { rows } = await ctx.db.query<{
    id: string;
    report_key: ReportKey;
    name: string;
    config: ReportConfig;
    shared: boolean;
    mine: boolean;
  }>(
    `SELECT id, report_key, name, config, shared, owner_user_id = $1 AS mine FROM saved_reports
     WHERE owner_user_id = $1 OR shared ORDER BY report_key, lower(name), id`,
    [ctx.userId],
  );
  return rows.map((r) => ({
    id: r.id,
    reportKey: r.report_key,
    name: r.name,
    config: r.config,
    shared: r.shared,
    mine: r.mine,
  }));
}

export async function saveReport(
  ctx: TenantContext,
  input: z.input<typeof savedReportSchema>,
): Promise<{ id: string }> {
  await ctx.requirePermission('report.read');
  const data = savedReportSchema.parse(input);
  const { rows } = await ctx.db.query<{ id: string }>(
    `INSERT INTO saved_reports (tenant_id, owner_user_id, report_key, name, config, shared, created_by, updated_by)
     VALUES (app_tenant_id(), $1, $2, $3, $4::jsonb, $5, $1, $1)
     ON CONFLICT (tenant_id, owner_user_id, report_key, name)
       DO UPDATE SET config = EXCLUDED.config, shared = EXCLUDED.shared, updated_by = $1
     RETURNING id`,
    [ctx.userId, data.reportKey, data.name, JSON.stringify(data.config), data.shared],
  );
  const id = rows[0]?.id ?? '';
  await ctx.audit({
    action: 'saved_report.saved',
    entityType: 'saved_reports',
    entityId: id,
    after: { report_key: data.reportKey, shared: data.shared },
  });
  return { id };
}

export async function deleteSavedReport(ctx: TenantContext, id: string): Promise<{ ok: true }> {
  await ctx.requirePermission('report.read');
  const res = await ctx.db.query('DELETE FROM saved_reports WHERE id = $1 AND owner_user_id = $2', [
    id,
    ctx.userId,
  ]);
  if (!res.rowCount) throw new NotFoundError();
  await ctx.audit({ action: 'saved_report.deleted', entityType: 'saved_reports', entityId: id });
  return { ok: true };
}
