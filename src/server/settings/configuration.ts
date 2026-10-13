import { z } from 'zod';
import { ConflictError, NotFoundError, type TenantContext } from '@/server/auth/with-tenant';
import { emitEvent } from '@/server/events';

/**
 * Admin → Settings, configuration part (5.2, settings.manage). Everything a tenant tunes lives in
 * code_lists / translations / tenant_settings / tenant_companies (rule 17):
 *   - code lists: collection policies, case stages, dispute reasons, payment behaviour — add,
 *     rename (sr-Latn + en), reorder, deactivate. A code is NEVER deleted: rows reference it, so
 *     "remove" = inactive (hidden from choices, still valid for history);
 *   - aging buckets: the day bounds of the existing codes (contiguous from 0, open-ended last);
 *   - attention thresholds, risk weights / bands, default policy, bulk limit;
 *   - working days and holidays per company (rule 26).
 * Every change: audit (before / after, P0) + domain event tenant_settings.updated, one transaction.
 */

export const EDITABLE_LISTS = [
  'collection_policy',
  'case_stage',
  'dispute_reason',
  'payment_behaviour',
  'aging_bucket',
] as const;
export type EditableList = (typeof EDITABLE_LISTS)[number];

const codeShape = z.string().regex(/^[a-z][a-z0-9_]{0,40}$/);
const label = z.string().trim().min(1).max(120);

export const codeUpsertSchema = z.object({
  code: codeShape,
  labels: z.object({ 'sr-Latn': label, en: label }),
  sortOrder: z.number().int().min(0).max(999).optional(),
  active: z.boolean().optional(),
});

async function changed(
  ctx: TenantContext,
  section: string,
  entity: { type: string; id: string },
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
): Promise<void> {
  await ctx.audit({
    action: `settings.${section}_changed`,
    entityType: entity.type,
    entityId: entity.id,
    ...(before ? { before } : {}),
    after,
  });
  await emitEvent(ctx.db, {
    eventType: 'tenant_settings.updated',
    aggregateType: entity.type,
    aggregateId: entity.id,
    payload: { section },
    requestId: ctx.requestId,
    actorId: ctx.userId,
  });
}

export type CodeEntry = {
  code: string;
  labels: Record<string, string>;
  active: boolean;
  system: boolean;
  sortOrder: number;
  inUse: boolean;
};

/** How many rows reference a code (fixed query per list — never input in SQL). */
const USAGE: Record<EditableList, string> = {
  collection_policy: `SELECT (SELECT count(*) FROM customers WHERE policy_code = $1)
                           + (SELECT count(*) FROM tenant_settings WHERE default_policy_code = $1) AS n`,
  case_stage: 'SELECT count(*) AS n FROM collection_cases WHERE stage_code = $1',
  dispute_reason: 'SELECT count(*) AS n FROM disputes WHERE reason_code = $1',
  payment_behaviour: 'SELECT count(*) AS n FROM customers WHERE payment_behaviour_code = $1',
  aging_bucket: 'SELECT count(*) AS n FROM aging_bucket_bounds WHERE code = $1',
};

export async function listCodes(ctx: TenantContext, listKey: EditableList): Promise<CodeEntry[]> {
  await ctx.requirePermission('settings.read');
  const { rows } = await ctx.db.query<{
    code: string;
    is_active: boolean;
    is_system: boolean;
    sort_order: number;
    labels: Record<string, string> | null;
  }>(
    `SELECT cl.code, cl.is_active, cl.is_system, cl.sort_order,
            (SELECT jsonb_object_agg(t.locale, t.text) FROM translations t
             WHERE t.entity_type = 'code_list' AND t.entity_key = cl.list_key || '.' || cl.code
               AND t.field = 'name') AS labels
     FROM code_lists cl WHERE cl.list_key = $1 ORDER BY cl.sort_order, cl.code`,
    [listKey],
  );
  const out: CodeEntry[] = [];
  for (const r of rows) {
    const usage = await ctx.db.query<{ n: string }>(USAGE[listKey], [r.code]);
    out.push({
      code: r.code,
      labels: r.labels ?? {},
      active: r.is_active,
      system: r.is_system,
      sortOrder: r.sort_order,
      inUse: Number(usage.rows[0]?.n ?? '0') > 0,
    });
  }
  return out;
}

/** Adds a code or updates its labels / order / active flag. Deactivation never deletes. */
export async function upsertCode(
  ctx: TenantContext,
  listKey: EditableList,
  input: z.input<typeof codeUpsertSchema>,
): Promise<{ code: string }> {
  await ctx.requirePermission('settings.manage');
  const data = codeUpsertSchema.parse(input);
  const { rows } = await ctx.db.query<{ is_active: boolean; sort_order: number }>(
    'SELECT is_active, sort_order FROM code_lists WHERE list_key = $1 AND code = $2 FOR UPDATE',
    [listKey, data.code],
  );
  const before = rows[0];
  if (!before) {
    // Aging buckets come with their bounds — a new bucket is not added here.
    if (listKey === 'aging_bucket') throw new ConflictError('unsupported');
    await ctx.db.query(
      `INSERT INTO code_lists (tenant_id, list_key, code, is_system, sort_order, is_active, created_by, updated_by)
       VALUES (app_tenant_id(), $1, $2, false, $3, $4, $5, $5)`,
      [listKey, data.code, data.sortOrder ?? 100, data.active ?? true, ctx.userId],
    );
  } else {
    if (data.active === false && listKey === 'aging_bucket') throw new ConflictError('unsupported');
    if (data.active === false && listKey === 'collection_policy') {
      const d = await ctx.db.query('SELECT 1 FROM tenant_settings WHERE default_policy_code = $1', [
        data.code,
      ]);
      if (d.rowCount) throw new ConflictError('conflict');
    }
    await ctx.db.query(
      `UPDATE code_lists SET sort_order = coalesce($3, sort_order), is_active = coalesce($4, is_active),
              updated_by = $5 WHERE list_key = $1 AND code = $2`,
      [listKey, data.code, data.sortOrder ?? null, data.active ?? null, ctx.userId],
    );
  }
  for (const [locale, text] of Object.entries(data.labels)) {
    await ctx.db.query(
      `INSERT INTO translations (tenant_id, entity_type, entity_key, field, locale, text, created_by, updated_by)
       VALUES (app_tenant_id(), 'code_list', $1, 'name', $2, $3, $4, $4)
       ON CONFLICT (tenant_id, entity_type, entity_key, field, locale)
         DO UPDATE SET text = EXCLUDED.text, updated_by = $4`,
      [`${listKey}.${data.code}`, locale, text, ctx.userId],
    );
  }
  await changed(
    ctx,
    'code_list',
    { type: 'code_lists', id: ctx.requestId },
    before ? { list_key: listKey, code: data.code, active: before.is_active } : null,
    { list_key: listKey, code: data.code, active: data.active ?? before?.is_active ?? true },
  );
  return { code: data.code };
}

// ---------------------------------------------------------------------------------------------
// Aging bucket bounds
// ---------------------------------------------------------------------------------------------

export const agingBoundsSchema = z
  .array(
    z.object({
      code: codeShape,
      min: z.number().int().min(0).max(36500),
      max: z.number().int().min(0).max(36500).nullable(),
    }),
  )
  .min(2)
  .max(12);

/** Contiguous from 0, no gap or overlap, the last one open-ended; codes must exist. */
export function validateBounds(bounds: z.infer<typeof agingBoundsSchema>): boolean {
  const sorted = [...bounds].sort((a, b) => a.min - b.min);
  if (sorted[0]?.min !== 0) return false;
  for (let i = 0; i < sorted.length; i += 1) {
    const b = sorted[i];
    const next = sorted[i + 1];
    if (!b) return false;
    if (next) {
      if (b.max === null || b.max < b.min || next.min !== b.max + 1) return false;
    } else if (b.max !== null) return false;
  }
  return new Set(bounds.map((b) => b.code)).size === bounds.length;
}

export async function listAgingBounds(ctx: TenantContext) {
  await ctx.requirePermission('settings.read');
  const { rows } = await ctx.db.query<{ code: string; min: number; max: number | null }>(
    `SELECT code, min_days_overdue AS min, max_days_overdue AS max FROM aging_bucket_bounds
     ORDER BY min_days_overdue`,
  );
  return rows;
}

export async function saveAgingBounds(
  ctx: TenantContext,
  input: z.input<typeof agingBoundsSchema>,
): Promise<{ ok: true }> {
  await ctx.requirePermission('settings.manage');
  const bounds = agingBoundsSchema.parse(input);
  if (!validateBounds(bounds)) throw new ConflictError('invalid_request');
  const before = await listAgingBounds(ctx);
  const known = new Set(before.map((b) => b.code));
  if (bounds.length !== known.size || bounds.some((b) => !known.has(b.code)))
    throw new ConflictError('invalid_request');
  for (const b of bounds) {
    await ctx.db.query(
      `UPDATE aging_bucket_bounds SET min_days_overdue = $2, max_days_overdue = $3, updated_by = $4
       WHERE code = $1`,
      [b.code, b.min, b.max, ctx.userId],
    );
  }
  await changed(
    ctx,
    'aging_buckets',
    { type: 'aging_bucket_bounds', id: ctx.requestId },
    { bounds: before.map((b) => `${b.code}:${b.min}-${b.max ?? ''}`) },
    { bounds: bounds.map((b) => `${b.code}:${b.min}-${b.max ?? ''}`) },
  );
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// Thresholds, risk, policy default, bulk limit
// ---------------------------------------------------------------------------------------------

const RISK_FACTORS = [
  'days_overdue',
  'exposure_vs_limit',
  'broken_promises_90d',
  'disputes_90d',
  'inactivity_days',
  'external_blocked',
] as const;

export const thresholdsSchema = z
  .object({
    attentionNoActivityDays: z.number().int().min(1).max(365),
    /** Decimal string in the reporting currency; null = "top 5" rule. */
    attentionLargeOverdue: z
      .string()
      .regex(/^\d{1,16}(\.\d{1,2})?$/)
      .nullable(),
    riskWeights: z.object(
      Object.fromEntries(RISK_FACTORS.map((f) => [f, z.number().int().min(0).max(100)])) as Record<
        (typeof RISK_FACTORS)[number],
        z.ZodNumber
      >,
    ),
    riskBandYellow: z.number().int().min(1).max(99),
    riskBandRed: z.number().int().min(2).max(100),
    defaultPolicyCode: codeShape,
    bulkMaxItems: z.number().int().min(1).max(5000),
  })
  .refine((v) => v.riskBandYellow < v.riskBandRed, { path: ['riskBandRed'] });
export type Thresholds = z.infer<typeof thresholdsSchema>;

export async function getThresholds(ctx: TenantContext): Promise<Thresholds> {
  await ctx.requirePermission('settings.read');
  const { rows } = await ctx.db.query<{
    attention_no_activity_days: number;
    attention_large_overdue: string | null;
    risk_weights: Record<string, number>;
    risk_band_yellow: number;
    risk_band_red: number;
    default_policy_code: string;
    bulk_max_items: number;
  }>(
    `SELECT attention_no_activity_days, attention_large_overdue::text, risk_weights, risk_band_yellow,
            risk_band_red, default_policy_code, bulk_max_items FROM tenant_settings`,
  );
  const r = rows[0];
  if (!r) throw new NotFoundError();
  return {
    attentionNoActivityDays: r.attention_no_activity_days,
    attentionLargeOverdue: r.attention_large_overdue,
    riskWeights: Object.fromEntries(
      RISK_FACTORS.map((f) => [f, r.risk_weights[f] ?? 0]),
    ) as Thresholds['riskWeights'],
    riskBandYellow: r.risk_band_yellow,
    riskBandRed: r.risk_band_red,
    defaultPolicyCode: r.default_policy_code,
    bulkMaxItems: r.bulk_max_items,
  };
}

export async function saveThresholds(
  ctx: TenantContext,
  input: z.input<typeof thresholdsSchema>,
): Promise<{ ok: true }> {
  await ctx.requirePermission('settings.manage');
  const data = thresholdsSchema.parse(input);
  const before = await getThresholds(ctx);
  const policy = await ctx.db.query(
    `SELECT 1 FROM code_lists WHERE list_key = 'collection_policy' AND code = $1 AND is_active`,
    [data.defaultPolicyCode],
  );
  if (!policy.rowCount) throw new ConflictError('invalid_request');
  await ctx.db.query(
    `UPDATE tenant_settings SET attention_no_activity_days = $1, attention_large_overdue = $2::numeric,
            risk_weights = $3::jsonb, risk_band_yellow = $4, risk_band_red = $5,
            default_policy_code = $6, bulk_max_items = $7`,
    [
      data.attentionNoActivityDays,
      data.attentionLargeOverdue,
      JSON.stringify(data.riskWeights),
      data.riskBandYellow,
      data.riskBandRed,
      data.defaultPolicyCode,
      data.bulkMaxItems,
    ],
  );
  await changed(
    ctx,
    'thresholds',
    { type: 'tenant_settings', id: ctx.tenantId },
    before as unknown as Record<string, unknown>,
    data as unknown as Record<string, unknown>,
  );
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// Working days and holidays per company (rule 26)
// ---------------------------------------------------------------------------------------------

export const calendarSchema = z.object({
  workingDays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
  holidays: z
    .array(
      z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        name: z.string().trim().min(1).max(120),
      }),
    )
    .max(200),
});

export type CompanyCalendar = {
  companyId: string;
  name: string;
  workingDays: number[];
  holidays: { date: string; name: string }[];
};

export async function listCalendars(ctx: TenantContext): Promise<CompanyCalendar[]> {
  await ctx.requirePermission('settings.read');
  const { rows } = await ctx.db.query<{
    id: string;
    display_name: string;
    working_days: number[];
    holidays: { date: string; name: string }[] | null;
  }>(
    `SELECT c.id, c.display_name, c.working_days,
            (SELECT json_agg(json_build_object('date', h.holiday_date::text, 'name', h.name) ORDER BY h.holiday_date)
             FROM company_holidays h WHERE h.company_id = c.id) AS holidays
     FROM tenant_companies c WHERE c.status = 'active' ORDER BY c.is_default DESC, c.display_name`,
  );
  return rows.map((r) => ({
    companyId: r.id,
    name: r.display_name,
    workingDays: r.working_days,
    holidays: r.holidays ?? [],
  }));
}

export async function saveCalendar(
  ctx: TenantContext,
  companyId: string,
  input: z.input<typeof calendarSchema>,
): Promise<{ ok: true }> {
  await ctx.requirePermission('settings.manage');
  const data = calendarSchema.parse(input);
  const days = [...new Set(data.workingDays)].sort();
  const before = await ctx.db.query<{ working_days: number[] }>(
    'SELECT working_days FROM tenant_companies WHERE id = $1 FOR UPDATE',
    [companyId],
  );
  if (!before.rows[0]) throw new NotFoundError();
  await ctx.db.query(
    'UPDATE tenant_companies SET working_days = $2::smallint[], updated_by = $3 WHERE id = $1',
    [companyId, days, ctx.userId],
  );
  await ctx.db.query('DELETE FROM company_holidays WHERE company_id = $1', [companyId]);
  for (const h of data.holidays) {
    await ctx.db.query(
      `INSERT INTO company_holidays (tenant_id, company_id, holiday_date, name, created_by)
       VALUES (app_tenant_id(), $1, $2::date, $3, $4) ON CONFLICT DO NOTHING`,
      [companyId, h.date, h.name, ctx.userId],
    );
  }
  await changed(
    ctx,
    'calendar',
    { type: 'tenant_companies', id: companyId },
    { working_days: before.rows[0].working_days },
    { working_days: days, holidays: data.holidays.length },
  );
  return { ok: true };
}
