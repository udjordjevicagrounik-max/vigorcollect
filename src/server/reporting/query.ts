import { z } from 'zod';
import type { Scope } from '@/server/auth/permissions';
import { scopeFilter } from '@/server/auth/scope';
import { InvalidRequestError, type TenantContext } from '@/server/auth/with-tenant';
import { listDefinitions, type CfDefinition } from '@/server/custom-fields/service';
import { likeContains } from '@/server/db-like';
import {
  DATASET_KEYS,
  DATASETS,
  datasetField,
  type Dataset,
  type DatasetField,
  type FieldType,
} from './datasets';

/**
 * Report builder query (6.2): a definition → ONE parametrized SELECT. Field names come only from
 * the dataset white list (or the tenant's P0 custom fields); values only as parameters; scope
 * always through scopeFilter on `c`. Aggregation in the database (numeric → text, never a float).
 * Over 10,000 result rows → refused (export only).
 */

export const ROW_LIMIT = 10_000;
export const EXPORT_ROW_LIMIT = 100_000;

const fieldRef = z.string().regex(/^([a-z][a-z0-9_]{0,62}|cf\.[a-z][a-z0-9_]{1,40})$/);
const relative = z.enum([
  'today',
  'yesterday',
  'last_7_days',
  'last_30_days',
  'last_90_days',
  'this_month',
  'last_month',
  'this_quarter',
  'this_year',
  'last_year',
]);
export type RelativeDate = z.infer<typeof relative>;

export const dimensionSchema = z.object({
  field: fieldRef,
  grain: z.enum(['day', 'week', 'month', 'quarter', 'year']).optional(),
});
export const measureSchema = z.union([
  z.object({
    field: fieldRef,
    agg: z.enum(['sum', 'count', 'avg', 'min', 'max']),
    /** Money: convert to the reporting currency (fx_convert); without it mixed currencies fail. */
    fx: z.boolean().default(true),
  }),
  z.object({ ratio: z.tuple([z.int().min(0).max(9), z.int().min(0).max(9)]) }),
]);
export const filterSchema = z.object({
  field: fieldRef,
  op: z.enum([
    'eq',
    'ne',
    'in',
    'gt',
    'gte',
    'lt',
    'lte',
    'between',
    'contains',
    'is_null',
    'not_null',
    'relative',
  ]),
  value: z
    .union([
      z.string().max(200),
      z.boolean(),
      z.array(z.string().max(200)).max(100),
      z.tuple([z.string().max(40), z.string().max(40)]),
      relative,
    ])
    .optional(),
});
export const definitionSchema = z.object({
  dataset: z.enum(DATASET_KEYS),
  dimensions: z.array(dimensionSchema).max(3).default([]),
  measures: z.array(measureSchema).min(1).max(10),
  filters: z.array(filterSchema).max(20).default([]),
  sort: z
    .array(z.object({ by: z.string().regex(/^[dm][0-9]$/), dir: z.enum(['asc', 'desc']) }))
    .max(3)
    .default([]),
  limit: z.int().min(1).max(ROW_LIMIT).default(1000),
});
export type ReportDefinitionInput = z.input<typeof definitionSchema>;
export type ReportDefinitionSpec = z.infer<typeof definitionSchema>;

export type ResultColumn = {
  id: string;
  field: string;
  role: 'dimension' | 'measure';
  type: FieldType;
  agg?: string;
  grain?: string;
  codeList?: string;
  /** Money measure: the currency of the values (reporting or the single source currency). */
  currency?: string;
  /** Custom field label (otherwise reports.fields.<field> in messages). */
  label?: string;
  drill?: boolean;
};

const RELATIVE_SQL: Record<RelativeDate, [string, string]> = {
  today: ['td.d', 'td.d'],
  yesterday: ['td.d - 1', 'td.d - 1'],
  last_7_days: ['td.d - 6', 'td.d'],
  last_30_days: ['td.d - 29', 'td.d'],
  last_90_days: ['td.d - 89', 'td.d'],
  this_month: ["date_trunc('month', td.d)::date", 'td.d'],
  last_month: [
    "(date_trunc('month', td.d) - interval '1 month')::date",
    "(date_trunc('month', td.d) - interval '1 day')::date",
  ],
  this_quarter: ["date_trunc('quarter', td.d)::date", 'td.d'],
  this_year: ["date_trunc('year', td.d)::date", 'td.d'],
  last_year: [
    "(date_trunc('year', td.d) - interval '1 year')::date",
    "(date_trunc('year', td.d) - interval '1 day')::date",
  ],
};

type Resolved = DatasetField & { label?: string; joinSql?: string };

/** A field of the dataset, or a P0 custom field of an entity the dataset has (joined once). */
function resolver(dataset: Dataset, customDefs: CfDefinition[], params: unknown[]) {
  const joins = new Map<string, Resolved>();
  return (ref: string): Resolved => {
    if (!ref.startsWith('cf.')) {
      const f = datasetField(dataset, ref);
      if (!f) throw new InvalidRequestError();
      return f;
    }
    const cached = joins.get(ref);
    if (cached) return cached;
    const key = ref.slice(3);
    const def = customDefs.find(
      (d) =>
        d.key === key &&
        d.piiClass === 'P0' &&
        d.status === 'active' &&
        dataset.customEntities[d.entityType as 'customer'],
    );
    if (!def || def.type === 'multiselect') throw new InvalidRequestError();
    const entityExpr = dataset.customEntities[def.entityType as 'customer'] ?? '';
    params.push(def.id);
    const alias = `cf${joins.size}`;
    const joinSql = `LEFT JOIN custom_field_values ${alias} ON ${alias}.entity_type = '${def.entityType}'
      AND ${alias}.entity_id = ${entityExpr} AND ${alias}.field_id = $${params.length}::uuid`;
    const base = { key: ref, kind: 'both' as const, label: def.label, joinSql };
    const resolved: Resolved =
      def.type === 'currency'
        ? {
            ...base,
            kind: 'measure',
            type: 'money',
            sql: `${alias}.value_numeric`,
            currencySql: `${alias}.value_currency`,
            reportingSql: `fx_convert(${alias}.value_numeric, ${alias}.value_currency, ts.default_currency, td.d)`,
          }
        : def.type === 'number'
          ? { ...base, type: 'number', sql: `${alias}.value_numeric` }
          : def.type === 'date'
            ? { ...base, kind: 'dimension', type: 'date', sql: `${alias}.value_date` }
            : def.type === 'bool'
              ? { ...base, kind: 'dimension', type: 'bool', sql: `${alias}.value_bool` }
              : def.type === 'select'
                ? {
                    ...base,
                    kind: 'dimension',
                    type: 'code',
                    sql: `${alias}.value_option_code`,
                    codeList: `cf_${def.entityType}_${def.key}`,
                  }
                : { ...base, kind: 'dimension', type: 'text', sql: `${alias}.value_text` };
    joins.set(ref, resolved);
    return resolved;
  };
}

export type BuiltQuery = {
  sql: string;
  params: unknown[];
  columns: ResultColumn[];
  /** Money measures without FX: their currency must be unique — checked before running. */
  currencyChecks: { sql: string; params: unknown[]; column: string }[];
};

/** Builds the SELECT. `mode` detail = un-aggregated entity rows (drill-down). */
export async function buildQuery(
  ctx: TenantContext,
  spec: ReportDefinitionSpec,
  viewer: { userId: string; scope: Scope },
  opts: {
    rowLimit: number;
    extraFilters?: z.infer<typeof filterSchema>[];
    mode?: 'aggregate' | 'detail';
  } = {
    rowLimit: ROW_LIMIT,
  },
): Promise<BuiltQuery> {
  const dataset = DATASETS[spec.dataset];
  const params: unknown[] = [];
  const refs = [
    ...spec.dimensions.map((d) => d.field),
    ...spec.filters.map((f) => f.field),
    ...(opts.extraFilters ?? []).map((f) => f.field),
    ...spec.measures.flatMap((m) => ('field' in m ? [m.field] : [])),
  ];
  const customDefs = refs.some((r) => r.startsWith('cf.')) ? await listDefinitions(ctx) : [];
  const resolve = resolver(dataset, customDefs, params);
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };

  const columns: ResultColumn[] = [];
  const select: string[] = [];
  const group: string[] = [];
  spec.dimensions.forEach((d, i) => {
    const f = resolve(d.field);
    if (f.kind === 'measure') throw new InvalidRequestError();
    const expr = f.type === 'date' && d.grain ? `date_trunc('${d.grain}', ${f.sql})::date` : f.sql;
    select.push(`(${expr})::text AS d${i}`);
    group.push(`d${i}`);
    columns.push({
      id: `d${i}`,
      field: d.field,
      role: 'dimension',
      type: f.type,
      ...(d.grain ? { grain: d.grain } : {}),
      ...(f.codeList ? { codeList: f.codeList } : {}),
      ...(f.label ? { label: f.label } : {}),
      drill: true,
    });
  });

  const measureSql: string[] = [];
  const currencyChecks: BuiltQuery['currencyChecks'] = [];
  spec.measures.forEach((m, i) => {
    if ('ratio' in m) {
      const [a, b] = m.ratio;
      const na = measureSql[a];
      const nb = measureSql[b];
      if (na === undefined || nb === undefined || a === i || b === i)
        throw new InvalidRequestError();
      measureSql.push(`round((${na}) * 100 / nullif((${nb}), 0), 2)`);
      columns.push({ id: `m${i}`, field: 'ratio', role: 'measure', type: 'percent' });
      return;
    }
    const f = m.field === 'count' ? datasetField(dataset, 'count') : resolve(m.field);
    if (!f || f.kind === 'dimension') throw new InvalidRequestError();
    let expr: string;
    let type: FieldType = f.type;
    if (m.agg === 'count') {
      expr = `count(${m.field === 'count' ? dataset.countSql : f.sql})`;
      type = 'number';
    } else if (f.type === 'money') {
      if (m.fx) expr = `${m.agg}(${f.reportingSql})`;
      else {
        expr = `${m.agg}(${f.sql})`;
        currencyChecks.push({ sql: f.currencySql ?? 'NULL', params: [], column: `m${i}` });
      }
    } else if (f.type === 'number') expr = `${m.agg}(${f.sql})`;
    else throw new InvalidRequestError();
    if (m.agg === 'avg') expr = `round(${expr}, 2)`;
    measureSql.push(expr);
    columns.push({
      id: `m${i}`,
      field: m.field,
      role: 'measure',
      type,
      agg: m.agg,
      ...('label' in f && f.label ? { label: String(f.label) } : {}),
    });
  });
  measureSql.forEach((e, i) => select.push(`(${e})::text AS m${i}`));

  // WHERE: scope first, then the filters (values as parameters, operators fixed).
  const where: string[] = [];
  for (const flt of [...spec.filters, ...(opts.extraFilters ?? [])]) {
    const f = resolve(flt.field);
    if (
      f.type === 'money' &&
      f.kind === 'measure' &&
      flt.op !== 'gt' &&
      flt.op !== 'gte' &&
      flt.op !== 'lt' &&
      flt.op !== 'lte'
    )
      throw new InvalidRequestError();
    const col = f.type === 'money' ? (f.reportingSql ?? f.sql) : f.sql;
    const cast =
      f.type === 'date' ? '::date' : f.type === 'number' || f.type === 'money' ? '::numeric' : '';
    const v = flt.value;
    switch (flt.op) {
      case 'eq':
      case 'ne':
        if (typeof v === 'boolean')
          where.push(`${col} ${flt.op === 'eq' ? 'IS' : 'IS NOT'} ${v ? 'TRUE' : 'FALSE'}`);
        else if (typeof v === 'string')
          where.push(
            `${col}${f.type === 'bool' ? '::text' : ''} ${flt.op === 'eq' ? '=' : '<>'} ${p(v)}${cast}`,
          );
        else throw new InvalidRequestError();
        break;
      case 'in':
        if (!Array.isArray(v)) throw new InvalidRequestError();
        where.push(`(${col})::text = ANY(${p(v)}::text[])`);
        break;
      case 'gt':
      case 'gte':
      case 'lt':
      case 'lte': {
        if (typeof v !== 'string' || !['date', 'number', 'money'].includes(f.type))
          throw new InvalidRequestError();
        const opSql = { gt: '>', gte: '>=', lt: '<', lte: '<=' }[flt.op];
        where.push(`${col} ${opSql} ${p(v)}${cast}`);
        break;
      }
      case 'between':
        if (!Array.isArray(v) || v.length !== 2 || f.type !== 'date')
          throw new InvalidRequestError();
        where.push(`${col} BETWEEN ${p(v[0])}::date AND ${p(v[1])}::date`);
        break;
      case 'relative': {
        if (typeof v !== 'string' || f.type !== 'date' || !(v in RELATIVE_SQL))
          throw new InvalidRequestError();
        const [from, to] = RELATIVE_SQL[v as RelativeDate];
        where.push(`${col} BETWEEN ${from} AND ${to}`);
        break;
      }
      case 'contains':
        if (typeof v !== 'string' || (f.type !== 'text' && f.type !== 'code'))
          throw new InvalidRequestError();
        where.push(`${col} ILIKE ${p(likeContains(v))}`);
        break;
      case 'is_null':
        where.push(`${col} IS NULL`);
        break;
      case 'not_null':
        where.push(`${col} IS NOT NULL`);
        break;
    }
  }
  const scope = scopeFilter('customers', viewer, 'c', params.length + 1);
  params.push(...scope.params);
  where.unshift(scope.sql);

  const joins = [...new Set(refs)]
    .filter((k) => k.startsWith('cf.'))
    .map((k) => resolve(k).joinSql ?? '');
  const from = `${dataset.from} ${joins.join(' ')}
    CROSS JOIN tenant_settings ts
    CROSS JOIN LATERAL (SELECT (now() AT TIME ZONE ts.timezone)::date AS d) td`;

  // The WHERE parameters only (the LIMIT parameter comes after) — for the currency checks.
  const whereParams = [...params];

  if (opts.mode === 'detail') {
    const sql = `SELECT DISTINCT (${dataset.detail.idSql})::text AS id, (${dataset.detail.labelSql}) AS label,
      c.id::text AS customer_id
      FROM ${from} WHERE ${where.join(' AND ')} ORDER BY 2, 1 LIMIT ${p(opts.rowLimit + 1)}`;
    return { sql, params, columns: [], currencyChecks: [] };
  }

  const order = spec.sort.length
    ? spec.sort
        .filter((s) => columns.some((c) => c.id === s.by))
        .map((s) => `${s.by} ${s.dir === 'asc' ? 'ASC' : 'DESC'} NULLS LAST`)
    : group.length
      ? [`${columns.find((c) => c.role === 'measure')?.id ?? 'd0'} DESC NULLS LAST`]
      : [];
  const sql = `SELECT ${select.join(', ')} FROM ${from} WHERE ${where.join(' AND ')}
    ${group.length ? `GROUP BY ${group.join(', ')}` : ''}
    ${order.length ? `ORDER BY ${order.join(', ')}` : ''}
    LIMIT ${p(Math.min(spec.limit, opts.rowLimit) + 1)}`;
  return {
    sql,
    params,
    columns,
    currencyChecks: currencyChecks.map((c) => ({
      sql: `SELECT array_agg(DISTINCT ${c.sql}) AS currencies FROM ${from} WHERE ${where.join(' AND ')}`,
      params: whereParams,
      column: c.column,
    })),
  };
}

export type ReportData = {
  columns: ResultColumn[];
  rows: Record<string, string | null>[];
  currency: string;
  truncated: boolean;
  labels: Record<string, Record<string, string>>;
};
