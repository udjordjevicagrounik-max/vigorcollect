import { z } from 'zod';
import { PermissionDeniedError } from '@/server/auth/permissions';
import {
  ConflictError,
  InvalidRequestError,
  NotFoundError,
  type TenantContext,
} from '@/server/auth/with-tenant';
import { scopedCustomer } from '@/server/collections/service';
import { getMasterKeyring, type MasterKeyring } from '@/server/crypto/keyring';
import { decryptField, encryptField, type SubjectRef } from '@/server/crypto/subject-keys';
import { emitEvent } from '@/server/events';

/**
 * Custom fields (6.1). A tenant adds fields to customers, contacts, invoices and cases; they then
 * appear without extra code in forms ("Additional fields"), list columns, filters and saved
 * filters, import mapping, rule conditions (custom_field.<key>), report dimensions / filters,
 * export and the API. Rules:
 *   - key, entity, type and pii_class never change; a field is archived, never deleted;
 *   - pii_class is mandatory (rule 20); a P1+ text is sealed with the subject key of the entity's
 *     customer (or the contact itself) and can never be a filter;
 *   - values in typed columns (rule 15) — numbers numeric(18,2), never a float on the way (rule 18);
 *   - at most tenant_settings.custom_fields_max active fields per entity.
 */

export const CF_ENTITIES = ['customer', 'contact', 'invoice', 'case'] as const;
export type CfEntity = (typeof CF_ENTITIES)[number];
export const CF_TYPES = [
  'text',
  'number',
  'date',
  'bool',
  'select',
  'multiselect',
  'currency',
] as const;
export type CfType = (typeof CF_TYPES)[number];

const PERMISSION: Record<CfEntity, { read: string; write: string }> = {
  customer: { read: 'customer.read', write: 'customer.update' },
  contact: { read: 'customer.read', write: 'customer.update' },
  invoice: { read: 'invoice.read', write: 'invoice.update' },
  case: { read: 'case.read', write: 'case.update' },
};

const label = z.string().trim().min(1).max(120);
const optionSchema = z.object({
  code: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/),
  labels: z.object({ 'sr-Latn': label, en: label }),
});

export const definitionCreateSchema = z
  .object({
    entityType: z.enum(CF_ENTITIES),
    key: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/),
    type: z.enum(CF_TYPES),
    labels: z.object({ 'sr-Latn': label, en: label }),
    piiClass: z.enum(['P0', 'P1', 'P2', 'P3']),
    required: z.boolean().default(false),
    filterable: z.boolean().default(false),
    showInList: z.boolean().default(false),
    position: z.number().int().min(0).max(999).default(0),
    options: z.array(optionSchema).max(100).default([]),
  })
  .refine((d) => d.piiClass === 'P0' || (d.type === 'text' && !d.filterable), {
    path: ['piiClass'],
  })
  .refine((d) => !['select', 'multiselect'].includes(d.type) || d.options.length > 0, {
    path: ['options'],
  });

export const definitionUpdateSchema = z.object({
  labels: z.object({ 'sr-Latn': label, en: label }).optional(),
  required: z.boolean().optional(),
  filterable: z.boolean().optional(),
  showInList: z.boolean().optional(),
  position: z.number().int().min(0).max(999).optional(),
  status: z.enum(['active', 'archived']).optional(),
  /** Added or relabelled options; an option is never removed (values may use it). */
  options: z.array(optionSchema).max(100).optional(),
});

export type CfDefinition = {
  id: string;
  entityType: CfEntity;
  key: string;
  type: CfType;
  label: string;
  labels: Record<string, string>;
  piiClass: 'P0' | 'P1' | 'P2' | 'P3';
  required: boolean;
  filterable: boolean;
  showInList: boolean;
  position: number;
  status: 'active' | 'archived';
  options: { code: string; label: string; active: boolean }[];
};

type DefRow = {
  id: string;
  entity_type: CfEntity;
  key: string;
  type: CfType;
  pii_class: CfDefinition['piiClass'];
  required: boolean;
  filterable: boolean;
  show_in_list: boolean;
  position: number;
  status: CfDefinition['status'];
  options_list_key: string | null;
  labels: Record<string, string> | null;
  options: { code: string; active: boolean; labels: Record<string, string> | null }[] | null;
};

const pick = (labels: Record<string, string> | null, locale: string, fallback: string) =>
  labels?.[locale] ?? labels?.['sr-Latn'] ?? labels?.en ?? fallback;

/** Definitions of an entity (or all), with labels in `locale`. No permission beyond membership. */
export async function listDefinitions(
  ctx: Pick<TenantContext, 'db'>,
  opts: {
    entityType?: CfEntity | undefined;
    includeArchived?: boolean;
    locale?: string | undefined;
  } = {},
): Promise<CfDefinition[]> {
  const locale = opts.locale ?? 'sr-Latn';
  const { rows } = await ctx.db.query<DefRow>(
    `SELECT d.id, d.entity_type, d.key, d.type, d.pii_class, d.required, d.filterable, d.show_in_list,
            d.position, d.status, d.options_list_key,
            (SELECT jsonb_object_agg(t.locale, t.text) FROM translations t
             WHERE t.entity_type = 'custom_field' AND t.entity_key = d.entity_type || '.' || d.key
               AND t.field = 'name') AS labels,
            (SELECT json_agg(json_build_object(
                      'code', cl.code, 'active', cl.is_active,
                      'labels', (SELECT jsonb_object_agg(t.locale, t.text) FROM translations t
                                 WHERE t.entity_type = 'code_list' AND t.entity_key = cl.list_key || '.' || cl.code
                                   AND t.field = 'name'))
                    ORDER BY cl.sort_order, cl.code)
             FROM code_lists cl WHERE cl.list_key = d.options_list_key) AS options
     FROM custom_field_definitions d
     WHERE ($1::text IS NULL OR d.entity_type = $1) AND ($2 OR d.status = 'active')
     ORDER BY d.entity_type, d.position, d.key`,
    [opts.entityType ?? null, opts.includeArchived ?? false],
  );
  return rows.map((r) => ({
    id: r.id,
    entityType: r.entity_type,
    key: r.key,
    type: r.type,
    label: pick(r.labels, locale, r.key),
    labels: r.labels ?? {},
    piiClass: r.pii_class,
    required: r.required,
    filterable: r.filterable,
    showInList: r.show_in_list,
    position: r.position,
    status: r.status,
    options: (r.options ?? []).map((o) => ({
      code: o.code,
      label: pick(o.labels, locale, o.code),
      active: o.active,
    })),
  }));
}

async function saveLabels(
  ctx: TenantContext,
  entityType: string,
  entityKey: string,
  labels: Record<string, string>,
) {
  for (const [locale, text] of Object.entries(labels)) {
    await ctx.db.query(
      `INSERT INTO translations (tenant_id, entity_type, entity_key, field, locale, text, created_by, updated_by)
       VALUES (app_tenant_id(), $1, $2, 'name', $3, $4, $5, $5)
       ON CONFLICT (tenant_id, entity_type, entity_key, field, locale)
         DO UPDATE SET text = EXCLUDED.text, updated_by = $5`,
      [entityType, entityKey, locale, text, ctx.userId],
    );
  }
}

async function saveOptions(
  ctx: TenantContext,
  listKey: string,
  options: z.infer<typeof optionSchema>[],
) {
  for (const [i, o] of options.entries()) {
    await ctx.db.query(
      `INSERT INTO code_lists (tenant_id, list_key, code, sort_order, created_by, updated_by)
       VALUES (app_tenant_id(), $1, $2, $3, $4, $4)
       ON CONFLICT (tenant_id, list_key, code) DO UPDATE SET sort_order = EXCLUDED.sort_order,
         is_active = true, updated_by = $4`,
      [listKey, o.code, i, ctx.userId],
    );
    await saveLabels(ctx, 'code_list', `${listKey}.${o.code}`, o.labels);
  }
}

async function changed(
  ctx: TenantContext,
  id: string,
  action: string,
  after: Record<string, unknown>,
) {
  await ctx.audit({ action, entityType: 'custom_field_definitions', entityId: id, after });
  await emitEvent(ctx.db, {
    eventType: 'tenant_settings.updated',
    aggregateType: 'custom_field_definitions',
    aggregateId: id,
    payload: { section: 'custom_fields' },
    requestId: ctx.requestId,
    actorId: ctx.userId,
  });
}

export async function createDefinition(
  ctx: TenantContext,
  input: z.input<typeof definitionCreateSchema>,
): Promise<{ id: string }> {
  await ctx.requirePermission('settings.manage');
  const d = definitionCreateSchema.parse(input);
  const { rows: cap } = await ctx.db.query<{ n: number; max: number }>(
    `SELECT (SELECT count(*) FROM custom_field_definitions WHERE entity_type = $1 AND status = 'active')::int AS n,
            coalesce((SELECT custom_fields_max FROM tenant_settings), 30) AS max`,
    [d.entityType],
  );
  if ((cap[0]?.n ?? 0) >= (cap[0]?.max ?? 30)) throw new ConflictError('limit_exceeded');
  let id: string;
  try {
    await ctx.db.query('SAVEPOINT cf_create');
    const { rows } = await ctx.db.query<{ id: string; options_list_key: string | null }>(
      `INSERT INTO custom_field_definitions (tenant_id, entity_type, key, type, pii_class, required, filterable,
                                             show_in_list, position, created_by, updated_by)
       VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $9) RETURNING id, options_list_key`,
      [
        d.entityType,
        d.key,
        d.type,
        d.piiClass,
        d.required,
        d.filterable,
        d.showInList,
        d.position,
        ctx.userId,
      ],
    );
    await ctx.db.query('RELEASE SAVEPOINT cf_create');
    id = rows[0]?.id ?? '';
    if (rows[0]?.options_list_key) await saveOptions(ctx, rows[0].options_list_key, d.options);
  } catch (error) {
    await ctx.db.query('ROLLBACK TO SAVEPOINT cf_create').catch(() => undefined);
    if ((error as { code?: string }).code === '23505') throw new ConflictError('conflict');
    throw error;
  }
  await saveLabels(ctx, 'custom_field', `${d.entityType}.${d.key}`, d.labels);
  await changed(ctx, id, 'custom_field.created', {
    entity_type: d.entityType,
    key: d.key,
    type: d.type,
    pii_class: d.piiClass,
  });
  return { id };
}

export async function updateDefinition(
  ctx: TenantContext,
  id: string,
  input: z.input<typeof definitionUpdateSchema>,
): Promise<{ ok: true }> {
  await ctx.requirePermission('settings.manage');
  const d = definitionUpdateSchema.parse(input);
  const { rows } = await ctx.db.query<{
    entity_type: string;
    key: string;
    pii_class: string;
    type: string;
    status: string;
    options_list_key: string | null;
  }>(
    `SELECT entity_type, key, pii_class, type, status, options_list_key FROM custom_field_definitions
     WHERE id = $1 FOR UPDATE`,
    [id],
  );
  const cur = rows[0];
  if (!cur) throw new NotFoundError();
  if (d.filterable && cur.pii_class !== 'P0') throw new ConflictError('invalid_request');
  if (d.status === 'active' && cur.status === 'archived') {
    const { rows: cap } = await ctx.db.query<{ full: boolean }>(
      `SELECT (SELECT count(*) FROM custom_field_definitions WHERE entity_type = $1 AND status = 'active')
              >= coalesce((SELECT custom_fields_max FROM tenant_settings), 30) AS full`,
      [cur.entity_type],
    );
    if (cap[0]?.full) throw new ConflictError('limit_exceeded');
  }
  await ctx.db.query(
    `UPDATE custom_field_definitions SET required = coalesce($2, required), filterable = coalesce($3, filterable),
            show_in_list = coalesce($4, show_in_list), position = coalesce($5, position),
            status = coalesce($6, status), updated_by = $7
     WHERE id = $1`,
    [
      id,
      d.required ?? null,
      d.filterable ?? null,
      d.showInList ?? null,
      d.position ?? null,
      d.status ?? null,
      ctx.userId,
    ],
  );
  if (d.labels) await saveLabels(ctx, 'custom_field', `${cur.entity_type}.${cur.key}`, d.labels);
  if (d.options && cur.options_list_key) await saveOptions(ctx, cur.options_list_key, d.options);
  await changed(ctx, id, 'custom_field.updated', {
    status: d.status ?? cur.status,
    key: cur.key,
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------------------------

/** The customer behind an entity (scope) and the encryption subject of its P1+ values. */
async function resolveEntity(
  ctx: TenantContext,
  entityType: CfEntity,
  entityId: string,
  permission: string,
): Promise<{ customerId: string; subject: SubjectRef }> {
  const sql: Record<CfEntity, string> = {
    customer: 'SELECT id AS customer_id FROM customers WHERE id = $1',
    contact: 'SELECT customer_id FROM customer_contacts WHERE id = $1',
    invoice: 'SELECT customer_id FROM invoices WHERE id = $1',
    case: 'SELECT customer_id FROM collection_cases WHERE id = $1',
  };
  const { rows } = await ctx.db.query<{ customer_id: string }>(sql[entityType], [entityId]);
  const customerId = rows[0]?.customer_id;
  if (!customerId) throw new NotFoundError();
  await scopedCustomer(ctx, customerId, permission);
  return {
    customerId,
    subject:
      entityType === 'contact'
        ? { type: 'customer_contact', id: entityId }
        : { type: 'customer', id: customerId },
  };
}

export type CfValue =
  string | number | boolean | string[] | { amount: string; currency: string } | null;

type ValueRow = {
  id: string;
  field_id: string;
  value_text: string | null;
  value_numeric: string | null;
  value_currency: string | null;
  value_date: string | null;
  value_bool: boolean | null;
  value_option_code: string | null;
  value_option_codes: string[] | null;
  value_text_enc: Buffer | null;
  value_text_key_version: number | null;
};

const VALUE_COLUMNS = `v.id, v.field_id, v.value_text, v.value_numeric::text, v.value_currency,
  v.value_date::text, v.value_bool, v.value_option_code, v.value_option_codes, v.value_text_enc,
  v.value_text_key_version`;

/** Values of one entity, keyed by field key (archived fields included — history). */
export async function getValues(
  ctx: TenantContext,
  entityType: CfEntity,
  entityId: string,
  keyring: MasterKeyring = getMasterKeyring(),
): Promise<Record<string, CfValue>> {
  const { subject } = await resolveEntity(ctx, entityType, entityId, PERMISSION[entityType].read);
  const defs = await listDefinitions(ctx, { entityType, includeArchived: true });
  const { rows } = await ctx.db.query<ValueRow>(
    `SELECT ${VALUE_COLUMNS} FROM custom_field_values v WHERE v.entity_type = $1 AND v.entity_id = $2`,
    [entityType, entityId],
  );
  const out: Record<string, CfValue> = {};
  for (const r of rows) {
    const def = defs.find((d) => d.id === r.field_id);
    if (!def) continue;
    out[def.key] = await readValue(ctx, def, r, subject, keyring);
  }
  return out;
}

async function readValue(
  ctx: TenantContext,
  def: CfDefinition,
  r: ValueRow,
  subject: SubjectRef,
  keyring: MasterKeyring,
): Promise<CfValue> {
  switch (def.type) {
    case 'text':
      if (r.value_text_enc && r.value_text_key_version)
        return decryptField(
          ctx.db,
          keyring,
          subject,
          { table: 'custom_field_values', column: 'value_text_enc', rowId: r.id },
          { ciphertext: r.value_text_enc, keyVersion: r.value_text_key_version },
        );
      return r.value_text;
    case 'number':
      return r.value_numeric;
    case 'currency':
      return r.value_numeric && r.value_currency
        ? { amount: r.value_numeric, currency: r.value_currency }
        : null;
    case 'date':
      return r.value_date;
    case 'bool':
      return r.value_bool;
    case 'select':
      return r.value_option_code;
    case 'multiselect':
      return r.value_option_codes ?? [];
  }
}

const DECIMAL = /^-?\d{1,16}(\.\d{1,2})?$/;

/** Validates one input value against its definition → the typed columns (no float, rule 18). */
function toColumns(def: CfDefinition, raw: unknown) {
  const empty =
    raw === null || raw === undefined || raw === '' || (Array.isArray(raw) && raw.length === 0);
  if (empty) return null;
  const options = new Set(def.options.filter((o) => o.active).map((o) => o.code));
  const bad = () => {
    throw new InvalidRequestError();
  };
  switch (def.type) {
    case 'text':
      if (typeof raw !== 'string' || raw.length > 2000) bad();
      return { text: String(raw) };
    case 'number': {
      const s = typeof raw === 'string' ? raw.trim() : '';
      if (!DECIMAL.test(s)) bad();
      return { numeric: s };
    }
    case 'currency': {
      const v = raw as { amount?: unknown; currency?: unknown };
      if (typeof v !== 'object' || typeof v.amount !== 'string' || !DECIMAL.test(v.amount.trim()))
        bad();
      if (typeof v.currency !== 'string' || !/^[A-Z]{3}$/.test(v.currency)) bad();
      return { numeric: String(v.amount).trim(), currency: String(v.currency) };
    }
    case 'date':
      if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) bad();
      return { date: String(raw) };
    case 'bool':
      if (typeof raw !== 'boolean') bad();
      return { bool: Boolean(raw) };
    case 'select':
      if (typeof raw !== 'string' || !options.has(raw)) bad();
      return { option: String(raw) };
    case 'multiselect':
      if (!Array.isArray(raw) || raw.some((x) => typeof x !== 'string' || !options.has(x))) bad();
      return { options: [...new Set(raw as string[])] };
  }
}

export const valuesSchema = z.record(z.string().regex(/^[a-z][a-z0-9_]{1,40}$/), z.unknown());

/**
 * Sets values of one entity (keys of ACTIVE fields only). Required fields may not be emptied.
 * Audit: which keys changed — never a value (a P1 value would leak into the audit log).
 */
export async function setValues(
  ctx: TenantContext,
  entityType: CfEntity,
  entityId: string,
  input: Record<string, unknown>,
  keyring: MasterKeyring = getMasterKeyring(),
  opts: { skipPermission?: boolean } = {},
): Promise<{ ok: true; changed: string[] }> {
  const values = valuesSchema.parse(input);
  const { subject } = opts.skipPermission
    ? await resolveForImport(ctx, entityType, entityId)
    : await resolveEntity(ctx, entityType, entityId, PERMISSION[entityType].write);
  const defs = await listDefinitions(ctx, { entityType });
  const byKey = new Map(defs.map((d) => [d.key, d]));
  const changed: string[] = [];
  for (const [key, raw] of Object.entries(values)) {
    const def = byKey.get(key);
    if (!def) throw new InvalidRequestError();
    const cols = toColumns(def, raw);
    if (!cols) {
      if (def.required) throw new ConflictError('invalid_request');
      await ctx.db.query(
        'DELETE FROM custom_field_values WHERE entity_type = $1 AND entity_id = $2 AND field_id = $3',
        [entityType, entityId, def.id],
      );
      changed.push(key);
      continue;
    }
    const { rows } = await ctx.db.query<{ id: string }>(
      `INSERT INTO custom_field_values (tenant_id, field_id, entity_type, entity_id, created_by, updated_by)
       VALUES (app_tenant_id(), $1, $2, $3, $4, $4)
       ON CONFLICT (tenant_id, entity_type, entity_id, field_id) DO UPDATE SET updated_by = $4
       RETURNING id`,
      [def.id, entityType, entityId, ctx.userId],
    );
    const rowId = rows[0]?.id ?? '';
    const sealed =
      'text' in cols && def.piiClass !== 'P0'
        ? await encryptField(
            ctx.db,
            keyring,
            subject,
            { table: 'custom_field_values', column: 'value_text_enc', rowId },
            cols.text,
          )
        : null;
    await ctx.db.query(
      `UPDATE custom_field_values SET value_text = $2, value_numeric = $3::numeric, value_currency = $4,
              value_date = $5::date, value_bool = $6, value_option_code = $7, value_option_codes = $8,
              value_text_enc = $9, value_text_key_version = $10
       WHERE id = $1`,
      [
        rowId,
        'text' in cols && !sealed ? cols.text : null,
        'numeric' in cols ? cols.numeric : null,
        'currency' in cols ? cols.currency : null,
        'date' in cols ? cols.date : null,
        'bool' in cols ? cols.bool : null,
        'option' in cols ? cols.option : null,
        'options' in cols ? cols.options : null,
        sealed?.ciphertext ?? null,
        sealed?.keyVersion ?? null,
      ],
    );
    changed.push(key);
  }
  // Required fields must have a value once the entity is edited.
  for (const def of defs.filter((d) => d.required && !(d.key in values))) {
    const has = await ctx.db.query(
      'SELECT 1 FROM custom_field_values WHERE entity_type = $1 AND entity_id = $2 AND field_id = $3',
      [entityType, entityId, def.id],
    );
    if (!has.rowCount && !opts.skipPermission) throw new ConflictError('invalid_request');
  }
  if (changed.length)
    await ctx.audit({
      action: 'custom_field.values_set',
      entityType: 'custom_field_values',
      entityId,
      after: { entity_type: entityType, fields: changed.length },
    });
  return { ok: true, changed };
}

/** Import (2.2 job): the run already checked import.create; the row belongs to this tenant. */
async function resolveForImport(ctx: TenantContext, entityType: CfEntity, entityId: string) {
  if (entityType !== 'customer' && entityType !== 'invoice') throw new PermissionDeniedError();
  const { rows } = await ctx.db.query<{ customer_id: string }>(
    entityType === 'customer'
      ? 'SELECT id AS customer_id FROM customers WHERE id = $1'
      : 'SELECT customer_id FROM invoices WHERE id = $1',
    [entityId],
  );
  const customerId = rows[0]?.customer_id;
  if (!customerId) throw new NotFoundError();
  return { customerId, subject: { type: 'customer', id: customerId } as SubjectRef };
}

// ---------------------------------------------------------------------------------------------
// Lists: filter predicates and list columns
// ---------------------------------------------------------------------------------------------

export type CfFilter = { key: string; value: string };

/**
 * EXISTS predicates for list filters on FILTERABLE (P0) fields; `idExpr` is the entity id column
 * of the caller's query (a fixed alias.column). Unknown / non-filterable keys → 400.
 */
export function customFieldPredicates(
  defs: CfDefinition[],
  entityType: CfEntity,
  idExpr: 'c.id' | 'p.invoice_id' | 'k.id',
  filters: CfFilter[],
  nextParam: number,
): { sql: string[]; params: unknown[] } {
  const sql: string[] = [];
  const params: unknown[] = [];
  for (const f of filters) {
    const def = defs.find((d) => d.key === f.key && d.entityType === entityType);
    if (!def || !def.filterable || def.piiClass !== 'P0') throw new InvalidRequestError();
    params.push(def.id);
    const fp = `$${nextParam + params.length - 1}`;
    params.push(f.value);
    const vp = `$${nextParam + params.length - 1}`;
    // One fixed comparison per type (never input in the SQL text).
    const cmp = {
      text: `lower(cfv.value_text) = lower(${vp})`,
      number: `cfv.value_numeric = ${vp}::numeric`,
      currency: `cfv.value_numeric = ${vp}::numeric`,
      date: `cfv.value_date = ${vp}::date`,
      bool: `cfv.value_bool = (${vp} = 'true')`,
      select: `cfv.value_option_code = ${vp}`,
      multiselect: `${vp} = ANY(cfv.value_option_codes)`,
    }[def.type];
    sql.push(
      `EXISTS (SELECT 1 FROM custom_field_values cfv WHERE cfv.entity_type = '${entityType}'
               AND cfv.entity_id = ${idExpr} AND cfv.field_id = ${fp}::uuid AND ${cmp})`,
    );
  }
  return { sql, params };
}

/** Parses ?cf.<key>=value pairs of a list URL (P0 filterable keys are checked later). */
export function cfFiltersFromQuery(raw: Record<string, string>): CfFilter[] {
  return Object.entries(raw)
    .filter(([k, v]) => /^cf\.[a-z][a-z0-9_]{1,40}$/.test(k) && v !== '' && v.length <= 200)
    .map(([k, v]) => ({ key: k.slice(3), value: v }));
}

/** P0 display values of list columns for many entities at once (P1+ are never shown in lists). */
export async function listColumnValues(
  ctx: Pick<TenantContext, 'db'>,
  entityType: CfEntity,
  fieldIds: string[],
  entityIds: string[],
): Promise<Map<string, Record<string, string>>> {
  const out = new Map<string, Record<string, string>>();
  if (!fieldIds.length || !entityIds.length) return out;
  const { rows } = await ctx.db.query<{
    entity_id: string;
    field_id: string;
    display: string | null;
  }>(
    `SELECT v.entity_id, v.field_id,
            coalesce(v.value_text, v.value_numeric::text || coalesce(' ' || v.value_currency, ''),
                     v.value_date::text, v.value_bool::text, v.value_option_code,
                     array_to_string(v.value_option_codes, ', ')) AS display
     FROM custom_field_values v JOIN custom_field_definitions d ON d.id = v.field_id
     WHERE v.entity_type = $1 AND v.field_id = ANY($2::uuid[]) AND v.entity_id = ANY($3::uuid[])
       AND d.pii_class = 'P0'`,
    [entityType, fieldIds, entityIds],
  );
  for (const r of rows) {
    const m = out.get(r.entity_id) ?? {};
    m[r.field_id] = r.display ?? '';
    out.set(r.entity_id, m);
  }
  return out;
}

/** The member's chosen columns for a list (default: fields marked show_in_list). */
export async function listColumns(
  ctx: TenantContext,
  listKey: 'customers' | 'invoices',
  locale: string,
): Promise<CfDefinition[]> {
  const entityType: CfEntity = listKey === 'customers' ? 'customer' : 'invoice';
  const defs = (await listDefinitions(ctx, { entityType, locale })).filter(
    (d) => d.piiClass === 'P0',
  );
  const { rows } = await ctx.db.query<{ field_ids: string[] }>(
    'SELECT field_ids FROM user_list_columns WHERE user_id = $1 AND list_key = $2',
    [ctx.userId, listKey],
  );
  const chosen = rows[0]?.field_ids;
  return chosen ? defs.filter((d) => chosen.includes(d.id)) : defs.filter((d) => d.showInList);
}

export const listColumnsSchema = z.object({
  listKey: z.enum(['customers', 'invoices']),
  fieldIds: z.array(z.uuid()).max(30),
});

export async function saveListColumns(
  ctx: TenantContext,
  input: z.input<typeof listColumnsSchema>,
): Promise<{ ok: true }> {
  const d = listColumnsSchema.parse(input);
  await ctx.requirePermission(d.listKey === 'customers' ? 'customer.read' : 'invoice.read');
  await ctx.db.query(
    `INSERT INTO user_list_columns (tenant_id, user_id, list_key, field_ids) VALUES (app_tenant_id(), $1, $2, $3)
     ON CONFLICT (tenant_id, user_id, list_key) DO UPDATE SET field_ids = EXCLUDED.field_ids`,
    [ctx.userId, d.listKey, d.fieldIds],
  );
  await ctx.audit({
    action: 'list_columns.saved',
    entityType: 'user_list_columns',
    entityId: ctx.userId,
    after: { list_key: d.listKey, columns: d.fieldIds.length },
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// Import (2.2 → 6.1)
// ---------------------------------------------------------------------------------------------

const foldLabel = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/**
 * A raw import cell → the API value of a field (same validation as the form afterwards);
 * null = not convertible (the row stays valid, the value is skipped and counted).
 */
export function fromImportCell(
  def: CfDefinition,
  raw: string,
  helpers: {
    amount: (v: string) => string | null;
    date: (v: string) => string | null;
    yesNo: (v: string) => boolean | null;
    currency: string;
  },
): unknown {
  const option = (v: string) => {
    const f = foldLabel(v);
    return (
      def.options.find((o) => o.active && (o.code === v || foldLabel(o.label) === f))?.code ?? null
    );
  };
  switch (def.type) {
    case 'text':
      return raw;
    case 'number':
      return helpers.amount(raw);
    case 'currency': {
      const a = helpers.amount(raw);
      return a === null ? null : { amount: a, currency: helpers.currency };
    }
    case 'date':
      return helpers.date(raw);
    case 'bool':
      return helpers.yesNo(raw);
    case 'select':
      return option(raw);
    case 'multiselect': {
      const codes = raw.split(/[;,]/).map((x) => option(x.trim()));
      return codes.every((c) => c !== null) ? codes : null;
    }
  }
}
