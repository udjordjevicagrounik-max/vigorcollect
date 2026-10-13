/**
 * Semantic layer of the report builder (6.2). A dataset is a FIXED FROM clause plus a white list
 * of fields; every field is a FIXED SQL expression over the dataset's aliases. A report definition
 * only names datasets, fields, aggregations and parameter values — never SQL. Every dataset joins
 * `customers c`, so scopeFilter('customers', …, 'c') limits it to the member's customers.
 *
 * Field kinds: dimension (GROUP BY), measure (aggregated), both. Types drive the formatting and
 * the allowed operators. Money fields carry the amount, its currency and the expression in the
 * tenant's reporting currency (fx_convert, migration 014) — a sum over several currencies without
 * FX is refused (rule 18), with FX it is converted.
 */

export type FieldType = 'text' | 'code' | 'date' | 'number' | 'money' | 'bool' | 'percent';

export type DatasetField = {
  key: string;
  kind: 'dimension' | 'measure' | 'both';
  type: FieldType;
  /** SQL over the dataset aliases (dimension value / measure input). */
  sql: string;
  /** Money: currency of `sql`, and the value in the reporting currency. */
  currencySql?: string;
  reportingSql?: string;
  /** Code fields: the code list whose labels are shown. */
  codeList?: string;
  /** Entity behind a row of this dimension (drill-down links). */
  entity?: { type: 'customer' | 'invoice' | 'case'; idSql: string };
};

export type Dataset = {
  key: DatasetKey;
  from: string;
  /** Entity id expression for custom fields of each entity type available here. */
  customEntities: Partial<Record<'customer' | 'invoice' | 'case', string>>;
  /** Default date field for relative date filters. */
  dateField: string;
  /** Count of the dataset's rows. */
  countSql: string;
  /** Entity of a detail row (drill-down list). */
  detail: { type: 'customer' | 'invoice' | 'case'; idSql: string; labelSql: string };
  fields: DatasetField[];
};

export const DATASET_KEYS = [
  'invoices',
  'customers',
  'cases',
  'promises',
  'activities',
  'disputes',
  'payments',
  'risk',
] as const;
export type DatasetKey = (typeof DATASET_KEYS)[number];

const CUSTOMER_FIELDS: DatasetField[] = [
  {
    key: 'customer',
    kind: 'dimension',
    type: 'text',
    sql: 'c.display_name',
    entity: { type: 'customer', idSql: 'c.id' },
  },
  { key: 'owner', kind: 'dimension', type: 'text', sql: 'own.display_name' },
  { key: 'team', kind: 'dimension', type: 'text', sql: 'tm.name' },
  {
    key: 'segment',
    kind: 'dimension',
    type: 'code',
    sql: 'c.segment_code',
    codeList: 'customer_segment',
  },
  { key: 'country', kind: 'dimension', type: 'code', sql: 'le.country_code' },
  { key: 'customer_status', kind: 'dimension', type: 'code', sql: 'c.status' },
  {
    key: 'payment_behaviour',
    kind: 'dimension',
    type: 'code',
    sql: 'c.payment_behaviour_code',
    codeList: 'payment_behaviour',
  },
  {
    key: 'policy',
    kind: 'dimension',
    type: 'code',
    sql: 'c.policy_code',
    codeList: 'collection_policy',
  },
  { key: 'natural_person', kind: 'dimension', type: 'bool', sql: 'c.is_natural_person' },
];

const CUSTOMER_JOINS = `JOIN customers c ON c.id = x.customer_id
  LEFT JOIN legal_entities_public le ON le.id = c.legal_entity_id
  LEFT JOIN users own ON own.id = c.owner_user_id
  LEFT JOIN teams tm ON tm.id = c.owner_team_id`;

const count = (sql = '*'): DatasetField => ({ key: 'count', kind: 'measure', type: 'number', sql });

export const DATASETS: Record<DatasetKey, Dataset> = {
  invoices: {
    key: 'invoices',
    from: `invoice_positions x ${CUSTOMER_JOINS}`,
    customEntities: { customer: 'c.id', invoice: 'x.invoice_id' },
    dateField: 'due_date',
    countSql: 'x.invoice_id',
    detail: {
      type: 'invoice',
      idSql: 'x.invoice_id',
      labelSql: "x.number || ' · ' || coalesce(c.display_name, '')",
    },
    fields: [
      ...CUSTOMER_FIELDS,
      {
        key: 'invoice_number',
        kind: 'dimension',
        type: 'text',
        sql: 'x.number',
        entity: { type: 'invoice', idSql: 'x.invoice_id' },
      },
      {
        key: 'aging_bucket',
        kind: 'dimension',
        type: 'code',
        sql: 'x.aging_bucket',
        codeList: 'aging_bucket',
      },
      { key: 'currency', kind: 'dimension', type: 'code', sql: 'x.currency' },
      { key: 'issue_date', kind: 'dimension', type: 'date', sql: 'x.issue_date' },
      { key: 'due_date', kind: 'dimension', type: 'date', sql: 'x.due_date' },
      { key: 'is_open', kind: 'dimension', type: 'bool', sql: 'x.is_open' },
      { key: 'is_overdue', kind: 'dimension', type: 'bool', sql: 'x.is_overdue' },
      { key: 'is_disputed', kind: 'dimension', type: 'bool', sql: 'x.is_disputed' },
      {
        key: 'open_amount',
        kind: 'measure',
        type: 'money',
        sql: 'x.amount_open',
        currencySql: 'x.currency',
        reportingSql: 'x.open_reporting',
      },
      {
        key: 'total_amount',
        kind: 'measure',
        type: 'money',
        sql: 'x.amount_total',
        currencySql: 'x.currency',
        reportingSql: 'x.total_reporting',
      },
      { key: 'days_overdue', kind: 'both', type: 'number', sql: 'x.days_overdue' },
      count('x.invoice_id'),
    ],
  },
  customers: {
    key: 'customers',
    from: `(SELECT id AS customer_id, created_at FROM customers) x ${CUSTOMER_JOINS}`,
    customEntities: { customer: 'c.id' },
    dateField: 'created_on',
    countSql: 'c.id',
    detail: { type: 'customer', idSql: 'c.id', labelSql: "coalesce(c.display_name, '')" },
    fields: [
      ...CUSTOMER_FIELDS,
      { key: 'created_on', kind: 'dimension', type: 'date', sql: 'x.created_at::date' },
      count('c.id'),
    ],
  },
  cases: {
    key: 'cases',
    from: `collection_cases x ${CUSTOMER_JOINS}`,
    customEntities: { customer: 'c.id', case: 'x.id' },
    dateField: 'opened_on',
    countSql: 'x.id',
    detail: {
      type: 'case',
      idSql: 'x.id',
      labelSql: "coalesce(c.display_name, '') || ' · ' || x.stage_code",
    },
    fields: [
      ...CUSTOMER_FIELDS,
      {
        key: 'stage',
        kind: 'dimension',
        type: 'code',
        sql: 'x.stage_code',
        codeList: 'case_stage',
      },
      { key: 'case_status', kind: 'dimension', type: 'code', sql: 'x.status' },
      { key: 'priority', kind: 'dimension', type: 'code', sql: 'x.priority' },
      { key: 'opened_on', kind: 'dimension', type: 'date', sql: 'x.opened_at::date' },
      {
        key: 'age_days',
        kind: 'measure',
        type: 'number',
        sql: '(extract(epoch FROM now() - x.opened_at) / 86400)::int',
      },
      count('x.id'),
    ],
  },
  promises: {
    key: 'promises',
    from: `promises x ${CUSTOMER_JOINS}`,
    customEntities: { customer: 'c.id' },
    dateField: 'promised_on',
    countSql: 'x.id',
    detail: {
      type: 'customer',
      idSql: 'c.id',
      labelSql: "coalesce(c.display_name, '') || ' · ' || x.promised_on",
    },
    fields: [
      ...CUSTOMER_FIELDS,
      { key: 'promise_status', kind: 'dimension', type: 'code', sql: 'x.status' },
      { key: 'promised_on', kind: 'dimension', type: 'date', sql: 'x.promised_on' },
      {
        key: 'promised_amount',
        kind: 'measure',
        type: 'money',
        sql: 'x.amount',
        currencySql: 'x.currency',
        reportingSql:
          '(SELECT fx_convert(x.amount, x.currency, ts.default_currency, x.promised_on) FROM tenant_settings ts)',
      },
      {
        key: 'paid_amount',
        kind: 'measure',
        type: 'money',
        sql: 'coalesce(x.paid_amount, 0)',
        currencySql: 'x.currency',
        reportingSql:
          '(SELECT fx_convert(coalesce(x.paid_amount, 0), x.currency, ts.default_currency, x.promised_on) FROM tenant_settings ts)',
      },
      count('x.id'),
    ],
  },
  activities: {
    key: 'activities',
    from: `activities x ${CUSTOMER_JOINS} LEFT JOIN users au ON au.id = x.actor_user_id`,
    customEntities: { customer: 'c.id' },
    dateField: 'occurred_on',
    countSql: 'x.id',
    detail: {
      type: 'customer',
      idSql: 'c.id',
      labelSql: "coalesce(c.display_name, '') || ' · ' || x.kind",
    },
    fields: [
      ...CUSTOMER_FIELDS,
      { key: 'activity_kind', kind: 'dimension', type: 'code', sql: 'x.kind' },
      {
        key: 'outcome',
        kind: 'dimension',
        type: 'code',
        sql: 'x.outcome_code',
        codeList: 'activity_outcome',
      },
      { key: 'actor', kind: 'dimension', type: 'text', sql: 'au.display_name' },
      { key: 'occurred_on', kind: 'dimension', type: 'date', sql: 'x.occurred_at::date' },
      count('x.id'),
    ],
  },
  disputes: {
    key: 'disputes',
    from: `disputes x ${CUSTOMER_JOINS}`,
    customEntities: { customer: 'c.id' },
    dateField: 'opened_on',
    countSql: 'x.id',
    detail: {
      type: 'customer',
      idSql: 'c.id',
      labelSql: "coalesce(c.display_name, '') || ' · ' || x.reason_code",
    },
    fields: [
      ...CUSTOMER_FIELDS,
      {
        key: 'reason',
        kind: 'dimension',
        type: 'code',
        sql: 'x.reason_code',
        codeList: 'dispute_reason',
      },
      { key: 'dispute_status', kind: 'dimension', type: 'code', sql: 'x.status' },
      { key: 'opened_on', kind: 'dimension', type: 'date', sql: 'x.opened_at::date' },
      {
        key: 'days_open',
        kind: 'measure',
        type: 'number',
        sql: '(extract(epoch FROM coalesce(x.resolved_at, now()) - x.opened_at) / 86400)::int',
      },
      count('x.id'),
    ],
  },
  payments: {
    key: 'payments',
    from: `payments x ${CUSTOMER_JOINS}`,
    customEntities: { customer: 'c.id' },
    dateField: 'paid_on',
    countSql: 'x.id',
    detail: {
      type: 'customer',
      idSql: 'c.id',
      labelSql: "coalesce(c.display_name, '') || ' · ' || x.paid_on",
    },
    fields: [
      ...CUSTOMER_FIELDS,
      { key: 'payment_kind', kind: 'dimension', type: 'code', sql: 'x.payment_kind' },
      { key: 'paid_on', kind: 'dimension', type: 'date', sql: 'x.paid_on' },
      { key: 'currency', kind: 'dimension', type: 'code', sql: 'x.currency' },
      {
        key: 'amount',
        kind: 'measure',
        type: 'money',
        sql: 'x.amount',
        currencySql: 'x.currency',
        reportingSql:
          '(SELECT fx_convert(x.amount, x.currency, ts.default_currency, x.paid_on) FROM tenant_settings ts)',
      },
      count('x.id'),
    ],
  },
  risk: {
    key: 'risk',
    from: `(SELECT DISTINCT ON (customer_id) customer_id, band, score, computed_at FROM risk_scores
            ORDER BY customer_id, computed_at DESC) x ${CUSTOMER_JOINS}`,
    customEntities: { customer: 'c.id' },
    dateField: 'scored_on',
    countSql: 'c.id',
    detail: {
      type: 'customer',
      idSql: 'c.id',
      labelSql: "coalesce(c.display_name, '') || ' · ' || x.band",
    },
    fields: [
      ...CUSTOMER_FIELDS,
      { key: 'band', kind: 'dimension', type: 'code', sql: 'x.band' },
      { key: 'scored_on', kind: 'dimension', type: 'date', sql: 'x.computed_at::date' },
      { key: 'score', kind: 'measure', type: 'number', sql: 'x.score' },
      count('c.id'),
    ],
  },
};

export function datasetField(dataset: Dataset, key: string): DatasetField | undefined {
  return dataset.fields.find((f) => f.key === key);
}
