import { z } from 'zod';
import type { Scope } from '@/server/auth/permissions';
import { ConflictError, NotFoundError, type TenantContext } from '@/server/auth/with-tenant';
import { codeLabels } from '@/server/receivables/service';
import { DATASETS } from './datasets';
import {
  buildQuery,
  definitionSchema,
  filterSchema,
  ROW_LIMIT,
  type ReportData,
  type ReportDefinitionSpec,
} from './query';

/**
 * Report definitions (6.2): saved builder reports — private, team or tenant-wide — plus the six
 * system reports (is_system, read-only, copied to change). Running a report = buildQuery() as the
 * member (report.read scope); money over several currencies without FX is refused.
 */

export const VISUALS = [
  'table',
  'bar',
  'stacked_bar',
  'line',
  'pie',
  'donut',
  'funnel',
  'kpi_number',
  'kpi_trend',
  'grouped_table',
] as const;
export type Visual = (typeof VISUALS)[number];

export const reportSaveSchema = z.object({
  name: z.string().trim().min(1).max(120),
  definition: definitionSchema,
  visual: z.enum(VISUALS).default('table'),
  visualConfig: z
    .record(
      z.string().regex(/^[a-z][a-zA-Z0-9_]{0,40}$/),
      z.union([z.string().max(100), z.boolean(), z.int()]),
    )
    .default({}),
  visibility: z.enum(['private', 'team', 'tenant']).default('private'),
  teamId: z.uuid().optional(),
});
export type ReportSave = z.input<typeof reportSaveSchema>;

export type SavedDefinition = {
  id: string;
  name: string;
  systemKey: string | null;
  isSystem: boolean;
  mine: boolean;
  visibility: string;
  visual: Visual;
  visualConfig: Record<string, string | boolean | number>;
  version: number;
  definition: ReportDefinitionSpec;
};

type Row = {
  id: string;
  name: string;
  system_key: string | null;
  is_system: boolean;
  owner_user_id: string | null;
  visibility: string;
  visual: Visual;
  visual_config: Record<string, string | boolean | number>;
  version: number;
  dataset: string;
  dimensions: unknown;
  measures: unknown;
  filters: unknown;
  sort: unknown;
  row_limit: number;
};

const VISIBLE = `(d.is_system OR d.owner_user_id = $1 OR d.visibility = 'tenant'
  OR (d.visibility = 'team' AND d.team_id IN (SELECT tm.team_id FROM team_members tm WHERE tm.user_id = $1)))`;

const toSaved = (r: Row, userId: string): SavedDefinition => ({
  id: r.id,
  name: r.name,
  systemKey: r.system_key,
  isSystem: r.is_system,
  mine: r.owner_user_id === userId,
  visibility: r.visibility,
  visual: r.visual,
  visualConfig: r.visual_config,
  version: r.version,
  definition: definitionSchema.parse({
    dataset: r.dataset,
    dimensions: r.dimensions,
    measures: r.measures,
    filters: r.filters,
    sort: r.sort,
    limit: r.row_limit,
  }),
});

export async function listReportDefinitions(ctx: TenantContext): Promise<SavedDefinition[]> {
  await ctx.requirePermission('report.read');
  const { rows } = await ctx.db.query<Row>(
    `SELECT d.* FROM report_definitions d WHERE ${VISIBLE}
     ORDER BY d.is_system DESC, lower(d.name), d.id`,
    [ctx.userId],
  );
  return rows.map((r) => toSaved(r, ctx.userId));
}

export async function getReportDefinition(
  ctx: TenantContext,
  id: string,
): Promise<SavedDefinition> {
  await ctx.requirePermission('report.read');
  const { rows } = await ctx.db.query<Row>(
    `SELECT d.* FROM report_definitions d WHERE d.id = $2 AND ${VISIBLE}`,
    [ctx.userId, id],
  );
  if (!rows[0]) throw new NotFoundError();
  return toSaved(rows[0], ctx.userId);
}

/** Creates (no id) or updates the member's own report (version + 1). */
export async function saveReportDefinition(
  ctx: TenantContext,
  input: ReportSave,
  id?: string,
): Promise<{ id: string; version: number }> {
  await ctx.requirePermission('report.read');
  const d = reportSaveSchema.parse(input);
  if (d.visibility === 'team' && !d.teamId) throw new ConflictError('invalid_request');
  // Publishing to a team or the tenant is a manager's step (report.export holders do it today).
  if (d.visibility !== 'private') await ctx.requirePermission('report.export');
  const def = d.definition;
  const values = [
    d.name,
    def.dataset,
    JSON.stringify(def.dimensions),
    JSON.stringify(def.measures),
    JSON.stringify(def.filters),
    JSON.stringify(def.sort),
    def.limit,
    d.visual,
    JSON.stringify(d.visualConfig),
    d.visibility,
    d.visibility === 'team' ? (d.teamId ?? null) : null,
    ctx.userId,
  ];
  let out: { id: string; version: number } | undefined;
  if (id) {
    const { rows } = await ctx.db.query<{ id: string; version: number }>(
      `UPDATE report_definitions SET name = $1, dataset = $2, dimensions = $3::jsonb, measures = $4::jsonb,
              filters = $5::jsonb, sort = $6::jsonb, row_limit = $7, visual = $8, visual_config = $9::jsonb,
              visibility = $10, team_id = $11, version = version + 1, updated_by = $12
       WHERE id = $13 AND owner_user_id = $12 AND NOT is_system RETURNING id, version`,
      [...values, id],
    );
    out = rows[0];
    if (!out) throw new NotFoundError();
  } else {
    const { rows } = await ctx.db.query<{ id: string; version: number }>(
      `INSERT INTO report_definitions (tenant_id, name, dataset, dimensions, measures, filters, sort, row_limit,
                                       visual, visual_config, visibility, team_id, owner_user_id, created_by, updated_by)
       VALUES (app_tenant_id(), $1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8, $9::jsonb, $10, $11, $12, $12, $12)
       RETURNING id, version`,
      values,
    );
    out = rows[0] ?? { id: '', version: 1 };
  }
  await ctx.audit({
    action: id ? 'report_definition.updated' : 'report_definition.created',
    entityType: 'report_definitions',
    entityId: out.id,
    after: {
      dataset: def.dataset,
      visual: d.visual,
      visibility: d.visibility,
      version: out.version,
    },
  });
  return out;
}

export async function deleteReportDefinition(
  ctx: TenantContext,
  id: string,
): Promise<{ ok: true }> {
  await ctx.requirePermission('report.read');
  const res = await ctx.db.query(
    'DELETE FROM report_definitions WHERE id = $1 AND owner_user_id = $2 AND NOT is_system',
    [id, ctx.userId],
  );
  if (!res.rowCount) throw new NotFoundError();
  await ctx.audit({
    action: 'report_definition.deleted',
    entityType: 'report_definitions',
    entityId: id,
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------------------------

async function viewer(
  ctx: TenantContext,
  permission: string,
): Promise<{ userId: string; scope: Scope }> {
  const { scope } = await ctx.requirePermission(permission);
  return { userId: ctx.userId, scope };
}

/** Runs a definition (spec) for the member. Over the row limit → too_many_rows (export instead). */
export async function runSpec(
  ctx: TenantContext,
  input: z.input<typeof definitionSchema>,
  opts: { rowLimit?: number; permission?: string; locale?: string } = {},
): Promise<ReportData> {
  const spec = definitionSchema.parse(input);
  const rowLimit = opts.rowLimit ?? ROW_LIMIT;
  const built = await buildQuery(ctx, spec, await viewer(ctx, opts.permission ?? 'report.read'), {
    rowLimit,
  });
  const { rows: ts } = await ctx.db.query<{ c: string }>(
    `SELECT coalesce((SELECT default_currency FROM tenant_settings), 'EUR') AS c`,
  );
  const reporting = ts[0]?.c ?? 'EUR';
  // Rule 18: a sum without FX over several currencies is meaningless — refuse it.
  const currencies: Record<string, string> = {};
  for (const check of built.currencyChecks) {
    const { rows } = await ctx.db.query<{ currencies: string[] | null }>(check.sql, check.params);
    const found = (rows[0]?.currencies ?? []).filter(Boolean);
    if (found.length > 1) throw new ConflictError('mixed_currencies');
    currencies[check.column] = found[0] ?? reporting;
  }
  const { rows } = await ctx.db.query<Record<string, string | null>>(built.sql, built.params);
  const limit = Math.min(spec.limit, rowLimit);
  if (rows.length > limit && limit >= ROW_LIMIT && rowLimit === ROW_LIMIT)
    throw new ConflictError('too_many_rows');
  const columns = built.columns.map((c) =>
    c.type === 'money' ? { ...c, currency: currencies[c.id] ?? reporting } : c,
  );
  const labels: ReportData['labels'] = {};
  for (const c of columns) {
    if (c.codeList && !labels[c.codeList])
      labels[c.codeList] = await codeLabels(ctx, c.codeList, opts.locale ?? 'sr-Latn');
  }
  return {
    columns,
    rows: rows.slice(0, limit),
    currency: reporting,
    truncated: rows.length > limit,
    labels,
  };
}

export const drillSchema = z.object({
  definition: definitionSchema,
  /** The clicked row: dimension index → its value (as returned by the run). */
  values: z.record(z.string().regex(/^d[0-2]$/), z.string().max(200).nullable()),
});

/** Drill-down: the entities behind one result row (at most 200), with links. */
export async function drill(
  ctx: TenantContext,
  input: z.input<typeof drillSchema>,
): Promise<{ items: { id: string; label: string; href: string }[]; truncated: boolean }> {
  const { definition, values } = drillSchema.parse(input);
  const extra: z.infer<typeof filterSchema>[] = [];
  for (const [col, value] of Object.entries(values)) {
    const dim = definition.dimensions[Number(col.slice(1))];
    if (!dim) throw new ConflictError('invalid_request');
    if (value === null) extra.push({ field: dim.field, op: 'is_null' });
    else if (dim.grain) {
      // A date bucket: from its first day to the day before the next bucket.
      const start = value.slice(0, 10);
      const end = nextBucket(start, dim.grain);
      extra.push({ field: dim.field, op: 'between', value: [start, end] });
    } else extra.push({ field: dim.field, op: 'eq', value });
  }
  const built = await buildQuery(ctx, definition, await viewer(ctx, 'report.read'), {
    rowLimit: 200,
    extraFilters: extra,
    mode: 'detail',
  });
  const { rows } = await ctx.db.query<{ id: string; label: string | null; customer_id: string }>(
    built.sql,
    built.params,
  );
  const type = DATASETS[definition.dataset].detail.type;
  // Links from the scoped detail rows themselves (the customer id comes with every row).
  const href = (r: { id: string; customer_id: string }) =>
    type === 'customer'
      ? `/customers/${r.id}`
      : type === 'invoice'
        ? `/customers/${r.customer_id}?tab=invoices`
        : `/customers/${r.customer_id}/cases/${r.id}`;
  const items = rows.slice(0, 200).map((r) => ({ id: r.id, label: r.label ?? '—', href: href(r) }));
  return { items, truncated: rows.length > 200 };
}

function nextBucket(start: string, grain: string): string {
  const d = new Date(`${start}T00:00:00Z`);
  if (grain === 'day') d.setUTCDate(d.getUTCDate() + 1);
  else if (grain === 'week') d.setUTCDate(d.getUTCDate() + 7);
  else if (grain === 'month') d.setUTCMonth(d.getUTCMonth() + 1);
  else if (grain === 'quarter') d.setUTCMonth(d.getUTCMonth() + 3);
  else d.setUTCFullYear(d.getUTCFullYear() + 1);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export const runRequestSchema = z.object({ definition: definitionSchema });

/** API: run a definition (preview / saved) — audited (who ran which dataset, how many rows). */
export async function runForApi(
  ctx: TenantContext,
  input: z.input<typeof runRequestSchema>,
  locale: string,
): Promise<ReportData> {
  const { definition } = runRequestSchema.parse(input);
  const data = await runSpec(ctx, definition, { locale });
  await ctx.audit({
    action: 'report.run',
    entityType: 'report_definitions',
    entityId: ctx.requestId,
    after: { dataset: definition.dataset, rows: data.rows.length },
  });
  return data;
}

/** API: drill-down, audited like a run. */
export async function drillForApi(ctx: TenantContext, input: z.input<typeof drillSchema>) {
  const out = await drill(ctx, input);
  await ctx.audit({
    action: 'report.drill',
    entityType: 'report_definitions',
    entityId: ctx.requestId,
    after: { items: out.items.length },
  });
  return out;
}
