import { z } from 'zod';
import { ConflictError, type TenantContext } from '@/server/auth/with-tenant';
import { createDefinition, listDefinitions } from '@/server/custom-fields/service';
import { definitionSchema as reportDefinitionSchema } from '@/server/reporting/query';
import { saveReportDefinition, VISUALS } from '@/server/reporting/service';
import { validateTemplate } from '@/server/templates/render';
import { createWorkflow } from '@/server/workflows/service';

/**
 * Config pack (6.4): a tenant's configuration as JSON — WITHOUT secrets (no integrations, keys,
 * mailbox, tokens) and without business data. Export: policies, rules (latest definition),
 * templates, aging bounds, roles (for reference), custom fields, shared reports, own dashboards.
 * Import adds what is missing and never overwrites: rules arrive as DRAFTS (publishing stays
 * maker-checker, rule 11), templates only when the key is new, roles are NOT imported (granting
 * power needs four eyes, S-06), aging bounds only when the codes match.
 */

const label = z.object({ 'sr-Latn': z.string().max(120), en: z.string().max(120) }).partial();
export const configPackSchema = z.object({
  version: z.literal(1),
  exportedAt: z.string().max(40),
  policies: z
    .array(z.object({ code: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/), labels: label }))
    .max(50),
  rules: z
    .array(
      z.object({
        key: z.string().regex(/^[a-z][a-z0-9_]{1,62}$/),
        name: z.string().max(120),
        definition: z.unknown(),
      }),
    )
    .max(200),
  templates: z
    .array(
      z.object({
        key: z.string().regex(/^[a-z][a-z0-9_]{1,62}$/),
        channel: z.enum(['email', 'document']),
        name: z.string().max(120),
        hasLegalEffect: z.boolean(),
        texts: z
          .array(
            z.object({
              locale: z.string().max(10),
              subject: z.string().max(300),
              body: z.string().max(50_000),
            }),
          )
          .max(5),
      }),
    )
    .max(100),
  agingBuckets: z
    .array(z.object({ code: z.string().max(40), min: z.int(), max: z.int().nullable() }))
    .max(12),
  roles: z
    .array(z.object({ key: z.string().max(62), permissions: z.array(z.string().max(80)).max(200) }))
    .max(50),
  customFields: z
    .array(
      z.object({
        entityType: z.enum(['customer', 'contact', 'invoice', 'case']),
        key: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/),
        type: z.enum(['text', 'number', 'date', 'bool', 'select', 'multiselect', 'currency']),
        piiClass: z.enum(['P0', 'P1', 'P2', 'P3']),
        labels: label,
        required: z.boolean(),
        filterable: z.boolean(),
        showInList: z.boolean(),
        position: z.int(),
        options: z
          .array(z.object({ code: z.string().max(63), label: z.string().max(120) }))
          .max(100),
      }),
    )
    .max(120),
  reports: z
    .array(
      z.object({ name: z.string().max(120), definition: z.unknown(), visual: z.enum(VISUALS) }),
    )
    .max(200),
  dashboards: z
    .array(
      z.object({
        name: z.string().max(120),
        widgets: z
          .array(
            z.object({
              kind: z.enum(['report', 'kpi', 'aging', 'attention', 'my_tasks', 'team_attention']),
              kpiKey: z.string().max(40).nullable(),
              reportName: z.string().max(120).nullable(),
              visual: z.enum(VISUALS).nullable(),
              size: z.union([
                z.literal(3),
                z.literal(4),
                z.literal(6),
                z.literal(8),
                z.literal(12),
              ]),
              position: z.int(),
              title: z.string().max(120).nullable(),
            }),
          )
          .max(60),
      }),
    )
    .max(20),
});
export type ConfigPack = z.infer<typeof configPackSchema>;

export async function exportConfigPack(ctx: TenantContext): Promise<ConfigPack> {
  await ctx.requirePermission('settings.manage');
  const q = <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    ctx.db.query<T>(sql, params).then((r) => r.rows);
  const labels = `(SELECT jsonb_object_agg(t.locale, t.text) FROM translations t
                   WHERE t.entity_type = 'code_list' AND t.entity_key = c.list_key || '.' || c.code AND t.field = 'name')`;
  const policies = await q<{ code: string; labels: Record<string, string> | null }>(
    `SELECT c.code, ${labels} AS labels FROM code_lists c WHERE c.list_key = 'collection_policy' ORDER BY c.sort_order, c.code`,
  );
  const rules = await q<{ key: string; name: string; definition: unknown }>(
    `SELECT w.key, w.name, v.definition FROM workflows w
     JOIN LATERAL (SELECT definition FROM workflow_versions x WHERE x.workflow_id = w.id
                   ORDER BY (x.status = 'published') DESC, x.version DESC LIMIT 1) v ON true
     WHERE w.status = 'active' ORDER BY w.key`,
  );
  const templates = await q<{
    key: string;
    channel: 'email' | 'document';
    name: string;
    has_legal_effect: boolean;
    texts: { locale: string; subject: string; body: string }[];
  }>(
    `SELECT t.key, t.channel, t.name, t.has_legal_effect,
            (SELECT json_agg(json_build_object('locale', x.locale, 'subject', x.subject, 'body', x.body) ORDER BY x.locale)
             FROM template_texts x WHERE x.template_id = t.id) AS texts
     FROM templates t WHERE t.status = 'active' ORDER BY t.channel, t.key`,
  );
  const aging = await q<{ code: string; min: number; max: number | null }>(
    'SELECT code, min_days_overdue AS min, max_days_overdue AS max FROM aging_bucket_bounds ORDER BY min_days_overdue',
  );
  const roles = await q<{ key: string; permissions: string[] }>(
    `SELECT r.key, coalesce(array_agg(p.key ORDER BY p.key) FILTER (WHERE p.key IS NOT NULL), '{}') AS permissions
     FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id LEFT JOIN permissions p ON p.id = rp.permission_id
     GROUP BY r.key ORDER BY r.key`,
  );
  const fields = await listDefinitions(ctx);
  const reports = await q<{
    name: string;
    dataset: string;
    dimensions: unknown;
    measures: unknown;
    filters: unknown;
    sort: unknown;
    row_limit: number;
    visual: (typeof VISUALS)[number];
  }>(
    `SELECT name, dataset, dimensions, measures, filters, sort, row_limit, visual FROM report_definitions
     WHERE NOT is_system AND (visibility = 'tenant' OR owner_user_id = $1) ORDER BY name`,
    [ctx.userId],
  );
  const dashboards = await q<{
    name: string;
    widgets: ConfigPack['dashboards'][number]['widgets'] | null;
  }>(
    `SELECT d.name,
            (SELECT json_agg(json_build_object('kind', w.kind, 'kpiKey', w.kpi_key, 'reportName', r.name, 'visual', w.visual,
                                               'size', w.size, 'position', w.position, 'title', w.title) ORDER BY w.position)
             FROM dashboard_widgets w LEFT JOIN report_definitions r ON r.id = w.report_id WHERE w.dashboard_id = d.id) AS widgets
     FROM dashboards d WHERE d.owner_user_id = $1 ORDER BY d.name`,
    [ctx.userId],
  );
  await ctx.audit({
    action: 'config_pack.exported',
    entityType: 'tenants',
    entityId: ctx.tenantId,
  });
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    policies: policies.map((p) => ({ code: p.code, labels: p.labels ?? {} })),
    rules: rules.map((r) => ({ key: r.key, name: r.name, definition: r.definition })),
    templates: templates.map((t) => ({
      key: t.key,
      channel: t.channel,
      name: t.name,
      hasLegalEffect: t.has_legal_effect,
      texts: t.texts ?? [],
    })),
    agingBuckets: aging,
    roles,
    customFields: fields.map((f) => ({
      entityType: f.entityType,
      key: f.key,
      type: f.type,
      piiClass: f.piiClass,
      labels: f.labels,
      required: f.required,
      filterable: f.filterable,
      showInList: f.showInList,
      position: f.position,
      options: f.options.map((o) => ({ code: o.code, label: o.label })),
    })),
    reports: reports.map((r) => ({
      name: r.name,
      visual: r.visual,
      definition: {
        dataset: r.dataset,
        dimensions: r.dimensions,
        measures: r.measures,
        filters: r.filters,
        sort: r.sort,
        limit: r.row_limit,
      },
    })),
    dashboards: dashboards.map((d) => ({ name: d.name, widgets: d.widgets ?? [] })),
  };
}

export type ImportCounts = Record<
  'policies' | 'rules' | 'templates' | 'agingBuckets' | 'customFields' | 'reports' | 'dashboards',
  number
> & {
  skipped: number;
};

export async function importConfigPack(ctx: TenantContext, input: unknown): Promise<ImportCounts> {
  await ctx.requirePermission('settings.manage');
  const pack = configPackSchema.parse(input);
  const n: ImportCounts = {
    policies: 0,
    rules: 0,
    templates: 0,
    agingBuckets: 0,
    customFields: 0,
    reports: 0,
    dashboards: 0,
    skipped: 0,
  };
  const exists = async (sql: string, params: unknown[]) =>
    Boolean((await ctx.db.query(sql, params)).rowCount);

  for (const p of pack.policies) {
    if (
      await exists(`SELECT 1 FROM code_lists WHERE list_key = 'collection_policy' AND code = $1`, [
        p.code,
      ])
    ) {
      n.skipped += 1;
      continue;
    }
    await ctx.db.query(
      `INSERT INTO code_lists (tenant_id, list_key, code, sort_order, created_by, updated_by)
       VALUES (app_tenant_id(), 'collection_policy', $1, 50, $2, $2)`,
      [p.code, ctx.userId],
    );
    for (const [locale, text] of Object.entries(p.labels))
      if (text)
        await ctx.db.query(
          `INSERT INTO translations (tenant_id, entity_type, entity_key, field, locale, text, created_by, updated_by)
           VALUES (app_tenant_id(), 'code_list', $1, 'name', $2, $3, $4, $4) ON CONFLICT DO NOTHING`,
          [`collection_policy.${p.code}`, locale, text, ctx.userId],
        );
    n.policies += 1;
  }
  for (const r of pack.rules) {
    if (await exists('SELECT 1 FROM workflows WHERE key = $1', [r.key])) {
      n.skipped += 1;
      continue;
    }
    await ctx.db.query('SAVEPOINT pack_rule');
    try {
      await createWorkflow(ctx, { key: r.key, name: r.name, definition: r.definition } as never);
      await ctx.db.query('RELEASE SAVEPOINT pack_rule');
      n.rules += 1;
    } catch {
      await ctx.db.query('ROLLBACK TO SAVEPOINT pack_rule');
      n.skipped += 1;
    }
  }
  for (const t of pack.templates) {
    if (
      await exists('SELECT 1 FROM templates WHERE key = $1 AND channel = $2', [t.key, t.channel])
    ) {
      n.skipped += 1;
      continue;
    }
    // The same whitelist as a template saved by hand (render.ts) — unsafe markup never enters.
    try {
      for (const x of t.texts) validateTemplate(x.subject, x.body);
    } catch {
      n.skipped += 1;
      continue;
    }
    await ctx.requirePermission('settings.manage');
    const { rows } = await ctx.db.query<{ id: string }>(
      `INSERT INTO templates (tenant_id, key, channel, name, version, has_legal_effect, created_by, updated_by)
       VALUES (app_tenant_id(), $1, $2, $3, 1, $4, $5, $5) RETURNING id`,
      [t.key, t.channel, t.name, t.hasLegalEffect, ctx.userId],
    );
    for (const x of t.texts)
      await ctx.db.query(
        `INSERT INTO template_texts (tenant_id, template_id, locale, subject, body)
         VALUES (app_tenant_id(), $1, $2, $3, $4)`,
        [rows[0]?.id, x.locale, x.subject, x.body],
      );
    n.templates += 1;
  }
  const current = await ctx.db.query<{ code: string }>(
    'SELECT code FROM aging_bucket_bounds ORDER BY min_days_overdue',
  );
  const codes = current.rows.map((r) => r.code).join(',');
  if (pack.agingBuckets.length && pack.agingBuckets.map((b) => b.code).join(',') === codes) {
    for (const b of pack.agingBuckets)
      await ctx.db.query(
        'UPDATE aging_bucket_bounds SET min_days_overdue = $2, max_days_overdue = $3, updated_by = $4 WHERE code = $1',
        [b.code, b.min, b.max, ctx.userId],
      );
    n.agingBuckets = pack.agingBuckets.length;
  }
  for (const f of pack.customFields) {
    if (
      await exists('SELECT 1 FROM custom_field_definitions WHERE entity_type = $1 AND key = $2', [
        f.entityType,
        f.key,
      ])
    ) {
      n.skipped += 1;
      continue;
    }
    await ctx.db.query('SAVEPOINT pack_field');
    try {
      await createDefinition(ctx, {
        entityType: f.entityType,
        key: f.key,
        type: f.type,
        piiClass: f.piiClass,
        labels: { 'sr-Latn': f.labels['sr-Latn'] ?? f.key, en: f.labels.en ?? f.key },
        required: f.required,
        filterable: f.filterable,
        showInList: f.showInList,
        position: f.position,
        options: f.options.map((o) => ({
          code: o.code,
          labels: { 'sr-Latn': o.label, en: o.label },
        })),
      });
      await ctx.db.query('RELEASE SAVEPOINT pack_field');
      n.customFields += 1;
    } catch {
      await ctx.db.query('ROLLBACK TO SAVEPOINT pack_field');
      n.skipped += 1;
    }
  }
  const reportIds = new Map<string, string>();
  for (const r of pack.reports) {
    const def = reportDefinitionSchema.safeParse(r.definition);
    if (!def.success) {
      n.skipped += 1;
      continue;
    }
    const { id } = await saveReportDefinition(ctx, {
      name: r.name,
      definition: def.data,
      visual: r.visual,
    });
    reportIds.set(r.name, id);
    n.reports += 1;
  }
  for (const d of pack.dashboards) {
    const { rows } = await ctx.db.query<{ id: string }>(
      `INSERT INTO dashboards (tenant_id, owner_user_id, name, created_by, updated_by)
       VALUES (app_tenant_id(), $1, $2, $1, $1) RETURNING id`,
      [ctx.userId, d.name],
    );
    for (const w of d.widgets) {
      const reportId = w.kind === 'report' ? reportIds.get(w.reportName ?? '') : null;
      if (w.kind === 'report' && !reportId) continue;
      await ctx.db.query(
        `INSERT INTO dashboard_widgets (tenant_id, dashboard_id, kind, report_id, kpi_key, visual, size, position, title, created_by)
         VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          rows[0]?.id,
          w.kind,
          reportId ?? null,
          w.kind === 'kpi' ? w.kpiKey : null,
          w.visual,
          w.size,
          w.position,
          w.title,
          ctx.userId,
        ],
      );
    }
    n.dashboards += 1;
  }
  if (!Object.values(n).some((v) => v > 0)) throw new ConflictError('no_valid_rows');
  await ctx.audit({
    action: 'config_pack.imported',
    entityType: 'tenants',
    entityId: ctx.tenantId,
    after: n,
  });
  return n;
}
