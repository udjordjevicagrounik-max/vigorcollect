import { z } from 'zod';
import { listAttention, type AttentionItem } from '@/server/attention/service';
import { PermissionDeniedError } from '@/server/auth/permissions';
import { ConflictError, NotFoundError, type TenantContext } from '@/server/auth/with-tenant';
import { getPreferences } from '@/server/notifications/digest';
import {
  codeLabels,
  getDashboard as getCollectionsFigures,
  myWorkToday,
  type WorkItem,
} from '@/server/receivables/service';
import type { ReportData } from '@/server/reporting/query';
import { getReportDefinition, runSpec, VISUALS, type Visual } from '@/server/reporting/service';

/**
 * Dashboards (6.3). A dashboard is a list of widgets on a 12-column grid (desktop; a list on a
 * phone). Home = the member's chosen dashboard → one a manager made the default of the member's
 * role → the system "Collections overview" (the 2.3 dashboard in this model, read-only, copied to
 * change). Widget data is cached in this process for 5 minutes per (dashboard, member, version);
 * "Refresh" bypasses it. Nothing is cached in the database or the browser (rule 16).
 */

export const KPI_KEYS = [
  'overdue_total',
  'open_total',
  'dso',
  'promises_today',
  'promises_broken',
  'open_cases',
  'collected_30',
  'collection_rate',
  'disputed',
] as const;
export type KpiKey = (typeof KPI_KEYS)[number];
export const WIDGET_KINDS = [
  'report',
  'kpi',
  'aging',
  'attention',
  'my_tasks',
  'team_attention',
] as const;
export const SIZES = [3, 4, 6, 8, 12] as const;
export const CACHE_MS = 5 * 60 * 1000;

export type Widget = {
  id: string;
  kind: (typeof WIDGET_KINDS)[number];
  reportId: string | null;
  kpiKey: KpiKey | null;
  visual: Visual | null;
  size: (typeof SIZES)[number];
  position: number;
  title: string | null;
};

export type DashboardSummary = {
  id: string;
  name: string;
  systemKey: string | null;
  isSystem: boolean;
  mine: boolean;
  visibility: string;
  defaultForRoles: string[];
  version: string;
};

type DashRow = {
  id: string;
  name: string;
  system_key: string | null;
  is_system: boolean;
  owner_user_id: string | null;
  visibility: string;
  default_for_roles: string[];
  updated_at: Date;
};

const VISIBLE = `(d.is_system OR d.owner_user_id = $1 OR d.visibility = 'tenant'
  OR (d.visibility = 'team' AND d.team_id IN (SELECT tm.team_id FROM team_members tm WHERE tm.user_id = $1)))`;

const summary = (r: DashRow, userId: string): DashboardSummary => ({
  id: r.id,
  name: r.name,
  systemKey: r.system_key,
  isSystem: r.is_system,
  mine: r.owner_user_id === userId,
  visibility: r.visibility,
  defaultForRoles: r.default_for_roles,
  version: r.updated_at.toISOString(),
});

export async function listDashboards(ctx: TenantContext): Promise<DashboardSummary[]> {
  const { rows } = await ctx.db.query<DashRow>(
    `SELECT d.* FROM dashboards d WHERE ${VISIBLE} ORDER BY d.is_system DESC, lower(d.name), d.id`,
    [ctx.userId],
  );
  return rows.map((r) => summary(r, ctx.userId));
}

async function visible(ctx: TenantContext, id: string): Promise<DashRow> {
  const { rows } = await ctx.db.query<DashRow>(
    `SELECT d.* FROM dashboards d WHERE d.id = $2 AND ${VISIBLE}`,
    [ctx.userId, id],
  );
  if (!rows[0]) throw new NotFoundError();
  return rows[0];
}

/** The member's home dashboard: own choice → role default → system. */
export async function homeDashboardId(ctx: TenantContext): Promise<string> {
  const { rows } = await ctx.db.query<{ id: string }>(
    `SELECT coalesce(
       (SELECT p.dashboard_id FROM user_dashboard_prefs p JOIN dashboards d ON d.id = p.dashboard_id
        WHERE p.user_id = $1 AND ${VISIBLE}),
       (SELECT d.id FROM dashboards d
        WHERE NOT d.is_system AND d.default_for_roles && ARRAY(
                SELECT r.key FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1)
          AND ${VISIBLE}
        ORDER BY d.updated_at DESC LIMIT 1),
       (SELECT d.id FROM dashboards d WHERE d.is_system AND d.system_key = 'collections_overview')) AS id`,
    [ctx.userId],
  );
  const id = rows[0]?.id;
  if (!id) throw new NotFoundError();
  return id;
}

export async function loadWidgets(ctx: TenantContext, dashboardId: string): Promise<Widget[]> {
  const { rows } = await ctx.db.query<{
    id: string;
    kind: Widget['kind'];
    report_id: string | null;
    kpi_key: KpiKey | null;
    visual: Visual | null;
    size: Widget['size'];
    position: number;
    title: string | null;
  }>(
    `SELECT id, kind, report_id, kpi_key, visual, size, position, title FROM dashboard_widgets
     WHERE dashboard_id = $1 ORDER BY position, id`,
    [dashboardId],
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    reportId: r.report_id,
    kpiKey: r.kpi_key,
    visual: r.visual,
    size: r.size,
    position: r.position,
    title: r.title,
  }));
}

// ---------------------------------------------------------------------------------------------
// Widget data (cached 5 min per dashboard + member + version)
// ---------------------------------------------------------------------------------------------

export type Figures = Awaited<ReturnType<typeof getCollectionsFigures>>;
export type WidgetData =
  | {
      kind: 'report';
      name: string;
      systemKey: string | null;
      visual: Visual;
      data: ReportData;
      definition: Record<string, unknown> & { dimensions: unknown[] };
    }
  | { kind: 'kpi' | 'aging'; figures: Figures; buckets: Record<string, string> }
  | { kind: 'attention'; items: AttentionItem[] }
  | {
      kind: 'my_tasks' | 'team_attention';
      items: WorkItem[];
      stages: Record<string, string>;
      actions: Record<string, string>;
    }
  | { kind: 'error'; code: string };

type CacheEntry = { at: number; data: Record<string, WidgetData> };
const CACHE_KEY = Symbol.for('collect.dashboardCache');
const cache: Map<string, CacheEntry> = ((globalThis as Record<symbol, unknown>)[CACHE_KEY] ??=
  new Map()) as Map<string, CacheEntry>;

export function clearDashboardCache(): void {
  cache.clear();
}

export async function dashboardData(
  ctx: TenantContext,
  dashboardId: string,
  locale: string,
  opts: { refresh?: boolean; now?: number } = {},
): Promise<{
  dashboard: DashboardSummary;
  widgets: Widget[];
  data: Record<string, WidgetData>;
  cachedAt: number;
}> {
  const row = await visible(ctx, dashboardId);
  const dashboard = summary(row, ctx.userId);
  const widgets = await loadWidgets(ctx, dashboardId);
  const now = opts.now ?? Date.now();
  const key = `${ctx.tenantId}:${dashboardId}:${ctx.userId}:${dashboard.version}:${locale}:${widgets.map((w) => w.id).join(',')}`;
  const hit = cache.get(key);
  const fresh = Boolean(hit && !opts.refresh && now - hit.at < CACHE_MS);
  // Operational lists (attention, my / team work) are always live — one acts on them at once;
  // only the computed widgets (reports, KPIs, aging) come from the 5-minute cache.
  const live = (w: Widget) =>
    w.kind === 'attention' || w.kind === 'my_tasks' || w.kind === 'team_attention';
  const data: Record<string, WidgetData> = {};
  if (fresh && hit)
    for (const w of widgets)
      if (!live(w) && hit.data[w.id]) data[w.id] = hit.data[w.id] as WidgetData;
  let figures: Figures | null = null;
  let buckets: Record<string, string> | null = null;
  const fig = async () => {
    figures ??= await getCollectionsFigures(ctx);
    buckets ??= await codeLabels(ctx, 'aging_bucket', locale);
    return { figures, buckets };
  };
  for (const w of widgets) {
    if (data[w.id]) continue;
    try {
      if (w.kind === 'kpi' || w.kind === 'aging') data[w.id] = { kind: w.kind, ...(await fig()) };
      else if (w.kind === 'attention') {
        const prefs = await getPreferences(ctx);
        const items = prefs.inAppAttention ? await listAttention(ctx) : [];
        data[w.id] = {
          kind: 'attention',
          items: prefs.inAppMail ? items : items.filter((i) => i.kind !== 'mail_undelivered'),
        };
      } else if (w.kind === 'my_tasks' || w.kind === 'team_attention')
        data[w.id] = {
          kind: w.kind,
          items: await myWorkToday(ctx, w.kind === 'my_tasks' ? 'own' : 'team'),
          stages: await codeLabels(ctx, 'case_stage', locale),
          actions: await codeLabels(ctx, 'next_action', locale),
        };
      else if (w.reportId) {
        const def = await getReportDefinition(ctx, w.reportId);
        data[w.id] = {
          kind: 'report',
          name: def.name,
          systemKey: def.systemKey,
          visual: w.visual ?? def.visual,
          data: await runSpec(ctx, def.definition, { locale }),
          definition: def.definition as unknown as Record<string, unknown> & {
            dimensions: unknown[];
          },
        };
      }
    } catch (error) {
      const code =
        error instanceof PermissionDeniedError
          ? 'forbidden'
          : error instanceof NotFoundError
            ? 'not_found'
            : error instanceof ConflictError
              ? error.code
              : null;
      if (!code) throw error;
      data[w.id] = { kind: 'error', code };
    }
  }
  const at = fresh && hit ? hit.at : now;
  cache.set(key, {
    at,
    data: Object.fromEntries(
      Object.entries(data).filter(([id]) => !live(widgets.find((w) => w.id === id) as Widget)),
    ),
  });
  // Keep the process cache small: drop expired entries.
  for (const [k, v] of cache) if (now - v.at >= CACHE_MS) cache.delete(k);
  return { dashboard, widgets, data, cachedAt: at };
}

// ---------------------------------------------------------------------------------------------
// Changes
// ---------------------------------------------------------------------------------------------

async function own(ctx: TenantContext, id: string): Promise<DashRow> {
  const row = await visible(ctx, id);
  if (row.owner_user_id !== ctx.userId) throw new NotFoundError();
  return row;
}

async function touch(ctx: TenantContext, id: string) {
  await ctx.db.query('UPDATE dashboards SET version = version + 1, updated_by = $2 WHERE id = $1', [
    id,
    ctx.userId,
  ]);
}

/** A personal copy (widgets included), made the member's home. */
export async function copyDashboard(
  ctx: TenantContext,
  id: string,
  name?: string,
): Promise<{ id: string }> {
  const src = await visible(ctx, id);
  const { rows } = await ctx.db.query<{ id: string }>(
    `INSERT INTO dashboards (tenant_id, owner_user_id, name, created_by, updated_by)
     VALUES (app_tenant_id(), $1, $2, $1, $1) RETURNING id`,
    [ctx.userId, (name ?? src.name).slice(0, 120)],
  );
  const copy = rows[0]?.id ?? '';
  await ctx.db.query(
    `INSERT INTO dashboard_widgets (tenant_id, dashboard_id, kind, report_id, kpi_key, visual, size, position, title, created_by)
     SELECT app_tenant_id(), $2, kind, report_id, kpi_key, visual, size, position, title, $3
     FROM dashboard_widgets WHERE dashboard_id = $1`,
    [id, copy, ctx.userId],
  );
  await setHome(ctx, copy);
  await ctx.audit({
    action: 'dashboard.copied',
    entityType: 'dashboards',
    entityId: copy,
    after: { from: id },
  });
  return { id: copy };
}

export async function setHome(ctx: TenantContext, id: string): Promise<{ ok: true }> {
  await visible(ctx, id);
  await ctx.db.query(
    `INSERT INTO user_dashboard_prefs (tenant_id, user_id, dashboard_id) VALUES (app_tenant_id(), $1, $2)
     ON CONFLICT (tenant_id, user_id) DO UPDATE SET dashboard_id = EXCLUDED.dashboard_id, updated_at = now()`,
    [ctx.userId, id],
  );
  await ctx.audit({ action: 'dashboard.home_set', entityType: 'dashboards', entityId: id });
  return { ok: true };
}

export const dashboardUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  visibility: z.enum(['private', 'team', 'tenant']).optional(),
  teamId: z.uuid().nullable().optional(),
  /** Role keys this dashboard is the home of (a manager publishes to the team). */
  defaultForRoles: z
    .array(z.string().regex(/^[a-z][a-z0-9_]{1,40}$/))
    .max(20)
    .optional(),
});

export async function updateDashboard(
  ctx: TenantContext,
  id: string,
  input: z.input<typeof dashboardUpdateSchema>,
): Promise<{ ok: true }> {
  const d = dashboardUpdateSchema.parse(input);
  const row = await own(ctx, id);
  if ((d.visibility && d.visibility !== 'private') || d.defaultForRoles?.length)
    await ctx.requirePermission('report.export');
  if (d.defaultForRoles?.length) await ctx.requirePermission('user.assign');
  const visibility = d.visibility ?? row.visibility;
  if (visibility === 'team' && !d.teamId) throw new ConflictError('invalid_request');
  await ctx.db.query(
    `UPDATE dashboards SET name = coalesce($2, name), visibility = $3, team_id = $4,
            default_for_roles = coalesce($5, default_for_roles), version = version + 1, updated_by = $6
     WHERE id = $1`,
    [
      id,
      d.name ?? null,
      visibility,
      visibility === 'team' ? d.teamId : null,
      d.defaultForRoles ?? null,
      ctx.userId,
    ],
  );
  await ctx.audit({
    action: 'dashboard.updated',
    entityType: 'dashboards',
    entityId: id,
    after: { visibility, default_for_roles: d.defaultForRoles?.length ?? 0 },
  });
  return { ok: true };
}

export async function deleteDashboard(ctx: TenantContext, id: string): Promise<{ ok: true }> {
  await own(ctx, id);
  await ctx.db.query('DELETE FROM dashboards WHERE id = $1', [id]);
  await ctx.audit({ action: 'dashboard.deleted', entityType: 'dashboards', entityId: id });
  return { ok: true };
}

export const widgetSchema = z.object({
  kind: z.enum(WIDGET_KINDS).default('report'),
  reportId: z.uuid().optional(),
  kpiKey: z.enum(KPI_KEYS).optional(),
  visual: z.enum(VISUALS).optional(),
  size: z.union([z.literal(3), z.literal(4), z.literal(6), z.literal(8), z.literal(12)]).default(6),
  title: z.string().trim().min(1).max(120).optional(),
});

/** Adds a widget; 'mine' = the member's own home dashboard (a personal copy is made if needed). */
export async function addWidget(
  ctx: TenantContext,
  target: string,
  input: z.input<typeof widgetSchema>,
): Promise<{ dashboardId: string; widgetId: string }> {
  const w = widgetSchema.parse(input);
  if ((w.kind === 'report') !== Boolean(w.reportId) || (w.kind === 'kpi') !== Boolean(w.kpiKey))
    throw new ConflictError('invalid_request');
  if (w.reportId) await getReportDefinition(ctx, w.reportId);
  let dashboardId = target;
  if (target === 'mine') {
    const home = await visible(ctx, await homeDashboardId(ctx));
    dashboardId =
      home.owner_user_id === ctx.userId ? home.id : (await copyDashboard(ctx, home.id)).id;
  } else await own(ctx, dashboardId);
  const { rows } = await ctx.db.query<{ id: string }>(
    `INSERT INTO dashboard_widgets (tenant_id, dashboard_id, kind, report_id, kpi_key, visual, size, position, title, created_by)
     VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6,
             coalesce((SELECT max(position) + 1 FROM dashboard_widgets WHERE dashboard_id = $1), 0), $7, $8)
     RETURNING id`,
    [
      dashboardId,
      w.kind,
      w.reportId ?? null,
      w.kpiKey ?? null,
      w.visual ?? null,
      w.size,
      w.title ?? null,
      ctx.userId,
    ],
  );
  await touch(ctx, dashboardId);
  const widgetId = rows[0]?.id ?? '';
  await ctx.audit({
    action: 'dashboard.widget_added',
    entityType: 'dashboard_widgets',
    entityId: widgetId,
    after: { kind: w.kind, dashboard_id: dashboardId },
  });
  return { dashboardId, widgetId };
}

export const widgetUpdateSchema = z.object({
  size: z.union([z.literal(3), z.literal(4), z.literal(6), z.literal(8), z.literal(12)]).optional(),
  visual: z.enum(VISUALS).nullable().optional(),
  title: z.string().trim().min(1).max(120).nullable().optional(),
});

export async function updateWidget(
  ctx: TenantContext,
  dashboardId: string,
  widgetId: string,
  input: z.input<typeof widgetUpdateSchema>,
): Promise<{ ok: true }> {
  const d = widgetUpdateSchema.parse(input);
  await own(ctx, dashboardId);
  const res = await ctx.db.query(
    `UPDATE dashboard_widgets SET size = coalesce($3, size),
            visual = CASE WHEN $4 THEN $5 ELSE visual END, title = CASE WHEN $6 THEN $7 ELSE title END
     WHERE id = $1 AND dashboard_id = $2`,
    [
      widgetId,
      dashboardId,
      d.size ?? null,
      d.visual !== undefined,
      d.visual ?? null,
      d.title !== undefined,
      d.title ?? null,
    ],
  );
  if (!res.rowCount) throw new NotFoundError();
  await touch(ctx, dashboardId);
  await ctx.audit({
    action: 'dashboard.widget_updated',
    entityType: 'dashboard_widgets',
    entityId: widgetId,
  });
  return { ok: true };
}

export async function removeWidget(
  ctx: TenantContext,
  dashboardId: string,
  widgetId: string,
): Promise<{ ok: true }> {
  await own(ctx, dashboardId);
  const res = await ctx.db.query(
    'DELETE FROM dashboard_widgets WHERE id = $1 AND dashboard_id = $2',
    [widgetId, dashboardId],
  );
  if (!res.rowCount) throw new NotFoundError();
  await touch(ctx, dashboardId);
  await ctx.audit({
    action: 'dashboard.widget_removed',
    entityType: 'dashboard_widgets',
    entityId: widgetId,
  });
  return { ok: true };
}

export const reorderSchema = z.object({ widgetIds: z.array(z.uuid()).max(100) });

/** Drag order (desktop) / up-down (phone): positions follow the given order. */
export async function reorderWidgets(
  ctx: TenantContext,
  dashboardId: string,
  input: z.input<typeof reorderSchema>,
): Promise<{ ok: true }> {
  const { widgetIds } = reorderSchema.parse(input);
  await own(ctx, dashboardId);
  await ctx.db.query(
    `UPDATE dashboard_widgets w SET position = o.pos - 1
     FROM unnest($2::uuid[]) WITH ORDINALITY AS o(id, pos)
     WHERE w.id = o.id AND w.dashboard_id = $1`,
    [dashboardId, widgetIds],
  );
  await touch(ctx, dashboardId);
  await ctx.audit({
    action: 'dashboard.reordered',
    entityType: 'dashboards',
    entityId: dashboardId,
  });
  return { ok: true };
}

export async function createDashboard(ctx: TenantContext, name: string): Promise<{ id: string }> {
  const n = z.string().trim().min(1).max(120).parse(name);
  const { rows } = await ctx.db.query<{ id: string }>(
    `INSERT INTO dashboards (tenant_id, owner_user_id, name, created_by, updated_by)
     VALUES (app_tenant_id(), $1, $2, $1, $1) RETURNING id`,
    [ctx.userId, n],
  );
  const id = rows[0]?.id ?? '';
  await setHome(ctx, id);
  await ctx.audit({ action: 'dashboard.created', entityType: 'dashboards', entityId: id });
  return { id };
}
