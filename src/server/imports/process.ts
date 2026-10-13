import type { AuditEntry } from '@/server/auth/audit';
import { ConflictError, NotFoundError, type TenantContext } from '@/server/auth/with-tenant';
import type { MasterKeyring } from '@/server/crypto/keyring';
import type { Queryable } from '@/server/crypto/subject-keys';
import {
  findOrCreateCompanyCustomer,
  findOrCreateConsumerByExternalId,
} from '@/server/customers/repository';
import { emitEvent } from '@/server/events';
import { fromMinor, toMinor } from '@/server/fx/money';
import { openGrid } from './crypto';
import { classifyParty, parseYesNo, type PartyRules } from './party';
import {
  mappingSchema,
  normalizeAmount,
  normalizeDate,
  validateRows,
  type ImportRow,
  type Mapping,
  type RowResult,
} from './rows';
import { fromImportCell, listDefinitions, setValues } from '@/server/custom-fields/service';

/**
 * Applying a confirmed import run (worker, event import.confirmed) and rolling one back.
 *
 * Idempotency (2.2): (source, external_id) is one invoice — a known invoice is updated, never
 * duplicated. amount_open is never written: a LOWER open amount from the source becomes a
 * `source_settlement` payment + allocation for the difference; anything else that changes money
 * (total, currency, customer, a higher open amount, any change to a paid invoice) becomes a
 * reconciliation exception for a person to decide. Metadata (number, due date, references)
 * follows the source.
 *
 * Review S-02: every row's customer is classified first (src/server/imports/party.ts, rules per
 * country from jurisdiction_profiles.party_id_rules + the optional "natural person" column). A
 * consumer never becomes a legal entity and its identifier is never stored; anything uncertain
 * is not imported — exception 'review_required'; an existing customer's natural-person flag is
 * never flipped by an import (also 'review_required').
 */

type Db = Queryable;
type Audit = (entry: AuditEntry) => Promise<void>;

type Existing = {
  id: string;
  customer_id: string;
  currency: string;
  amount_total: string;
  amount_open: string;
  number: string;
  due_date: string;
  buyer_reference: string | null;
  order_reference: string | null;
};

type Counts = {
  created: number;
  updated: number;
  unchanged: number;
  customers: number;
  exceptions: number;
};

async function exception(
  db: Db,
  runId: string,
  rowNumber: number | null,
  invoiceId: string | null,
  kind: string,
  amounts?: { currency: string; old: string; new: string },
): Promise<void> {
  await db.query(
    `INSERT INTO reconciliation_exceptions (tenant_id, run_id, invoice_id, row_number, kind, currency,
                                            old_amount, new_amount)
     VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7)`,
    [
      runId,
      invoiceId,
      rowNumber,
      kind,
      amounts?.currency ?? null,
      amounts?.old ?? null,
      amounts?.new ?? null,
    ],
  );
}

/**
 * The source lowered the open amount without a payment we know of → an ADJUSTMENT (payment_kind
 * 'adjustment', reason 'unknown' until a person classifies it). Never counted as collected (015).
 */
async function settle(
  db: Db,
  run: { id: string; sourceId: string; today: string },
  invoice: { id: string; customerId: string; currency: string },
  amount: string,
): Promise<void> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO payments (tenant_id, customer_id, source_id, kind, paid_on, amount, currency, import_run_id,
                           adjustment_reason_code)
     VALUES (app_tenant_id(), $1, $2, 'source_settlement', $3, $4, $5, $6, 'unknown') RETURNING id`,
    [invoice.customerId, run.sourceId, run.today, amount, invoice.currency, run.id],
  );
  await db.query(
    `INSERT INTO payment_allocations (tenant_id, payment_id, invoice_id, amount, method)
     VALUES (app_tenant_id(), $1, $2, $3, 'source')`,
    [rows[0]?.id, invoice.id, amount],
  );
}

/** Party rules of a country (cached per run); no profile / no rules = {} → uncertain. */
async function partyRules(
  db: Db,
  cache: Map<string, PartyRules>,
  country: string,
): Promise<PartyRules> {
  const hit = cache.get(country);
  if (hit) return hit;
  const { rows } = await db.query<{ rules: PartyRules }>(
    'SELECT party_id_rules AS rules FROM jurisdiction_profiles WHERE country_code = $1',
    [country],
  );
  const rules = rows[0]?.rules ?? {};
  cache.set(country, rules);
  return rules;
}

/** The row's customer, or null when a person must look at it (exception already written). */
async function resolveCustomer(
  db: Db,
  keyring: MasterKeyring,
  run: { id: string; timezone: string },
  rowNumber: number,
  row: ImportRow,
  rulesCache: Map<string, PartyRules>,
  counts: Counts,
): Promise<string | null> {
  const review = async () => {
    await exception(db, run.id, rowNumber, null, 'review_required');
    counts.exceptions += 1;
    return null;
  };
  const kind = classifyParty(
    await partyRules(db, rulesCache, row.customerCountry),
    row.customerTaxId,
    row.customerIsNaturalPerson,
  );
  if (kind === 'uncertain') return review();
  if (kind === 'consumer') {
    // Only the source system's customer id can find the same consumer again.
    if (!row.customerExternalId) return review();
    const consumer = await findOrCreateConsumerByExternalId(db, keyring, {
      externalId: row.customerExternalId,
      displayName: row.customerName,
    });
    if (consumer.created) counts.customers += 1;
    return consumer.id;
  }
  const naturalPerson = kind === 'sole_trader';
  const customer = await findOrCreateCompanyCustomer(db, keyring, {
    countryCode: row.customerCountry,
    taxId: row.customerTaxId,
    legalName: row.customerName,
    timezone: run.timezone,
    registrationNumber: row.customerRegistrationNumber,
    externalId: row.customerExternalId,
    isNaturalPerson: naturalPerson,
  });
  if (!customer.created && customer.isNaturalPerson !== naturalPerson) return review();
  if (customer.created) counts.customers += 1;
  return customer.id;
}

async function applyRow(
  db: Db,
  keyring: MasterKeyring,
  run: { id: string; sourceId: string; companyId: string; today: string; timezone: string },
  rowNumber: number,
  row: ImportRow,
  customers: Map<string, string | null>,
  rulesCache: Map<string, PartyRules>,
  counts: Counts,
): Promise<void> {
  const key = `${row.customerCountry}|${row.customerTaxId}|${row.customerIsNaturalPerson}`;
  let customerId = customers.get(key);
  if (customerId === undefined) {
    customerId = await resolveCustomer(db, keyring, run, rowNumber, row, rulesCache, counts);
    customers.set(key, customerId);
  } else if (customerId === null) {
    await exception(db, run.id, rowNumber, null, 'review_required');
    counts.exceptions += 1;
  }
  if (!customerId) return;

  const found = await db.query<Existing>(
    `SELECT id, customer_id, currency, amount_total, amount_open, number, due_date::text AS due_date,
            buyer_reference, order_reference
     FROM invoices WHERE source_id = $1 AND external_id = $2 FOR UPDATE`,
    [run.sourceId, row.externalId],
  );
  const existing = found.rows[0];

  if (!existing) {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO invoices (tenant_id, company_id, customer_id, source_id, external_id, number,
                             issue_date, due_date, currency, amount_net, amount_tax, amount_total,
                             amount_open, buyer_reference, order_reference, import_run_id,
                             last_import_run_id)
       VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11, $12, $13, $14, $14)
       RETURNING id`,
      [
        run.companyId,
        customerId,
        run.sourceId,
        row.externalId,
        row.number,
        row.issueDate,
        row.dueDate,
        row.currency,
        row.amountNet,
        row.amountTax,
        row.amountTotal,
        row.buyerReference,
        row.orderReference,
        run.id,
      ],
    );
    const id = rows[0]?.id ?? '';
    const settled = toMinor(row.amountTotal) - toMinor(row.amountOpen);
    if (settled > 0n) {
      await settle(db, run, { id, customerId, currency: row.currency }, fromMinor(settled));
    }
    await emitEvent(db, {
      eventType: 'invoice.imported',
      aggregateType: 'invoices',
      aggregateId: id,
      payload: { import_run_id: run.id },
    });
    counts.created += 1;
    return;
  }

  const money = { currency: existing.currency };
  if (existing.customer_id !== customerId) {
    await exception(db, run.id, rowNumber, existing.id, 'customer_changed');
    counts.exceptions += 1;
    return;
  }
  if (existing.currency !== row.currency) {
    await exception(db, run.id, rowNumber, existing.id, 'currency_changed');
    counts.exceptions += 1;
    return;
  }
  const paid = toMinor(existing.amount_open) === 0n;
  if (toMinor(existing.amount_total) !== toMinor(row.amountTotal)) {
    await exception(
      db,
      run.id,
      rowNumber,
      existing.id,
      paid ? 'paid_invoice_changed' : 'total_changed',
      {
        ...money,
        old: existing.amount_total,
        new: row.amountTotal,
      },
    );
    counts.exceptions += 1;
    return;
  }
  const delta = toMinor(existing.amount_open) - toMinor(row.amountOpen);
  if (delta < 0n) {
    await exception(
      db,
      run.id,
      rowNumber,
      existing.id,
      paid ? 'paid_invoice_changed' : 'open_amount_increased',
      {
        ...money,
        old: existing.amount_open,
        new: row.amountOpen,
      },
    );
    counts.exceptions += 1;
    return;
  }

  const metadataChanged =
    existing.number !== row.number ||
    existing.due_date !== row.dueDate ||
    existing.buyer_reference !== row.buyerReference ||
    existing.order_reference !== row.orderReference;
  if (delta === 0n && !metadataChanged) {
    counts.unchanged += 1;
    return;
  }
  await db.query(
    `UPDATE invoices SET number = $2, due_date = $3, buyer_reference = $4, order_reference = $5,
            last_import_run_id = $6
     WHERE id = $1`,
    [existing.id, row.number, row.dueDate, row.buyerReference, row.orderReference, run.id],
  );
  if (delta > 0n) {
    await settle(
      db,
      run,
      { id: existing.id, customerId, currency: existing.currency },
      fromMinor(delta),
    );
  }
  counts.updated += 1;
}

/** Worker handler body for import.confirmed — inside withTenantJob (one transaction). */
export async function applyImport(
  db: Db,
  audit: Audit,
  keyring: MasterKeyring,
  tenantId: string,
  runId: string,
): Promise<'applied' | 'skipped'> {
  const { rows } = await db.query<{
    id: string;
    status: string;
    source_id: string;
    company_id: string;
    payload_enc: Buffer | null;
    payload_key_version: number | null;
    mapping: unknown;
    today: string;
    timezone: string;
    currency: string;
    country: string;
  }>(
    `SELECT r.id, r.status, r.source_id, r.company_id, r.payload_enc, r.payload_key_version, r.mapping,
            (now() AT TIME ZONE le.timezone)::date::text AS today, le.timezone,
            ts.default_currency AS currency, ts.country_code AS country
     FROM import_runs r
     JOIN tenant_companies c ON c.id = r.company_id
     JOIN legal_entities_public le ON le.id = c.legal_entity_id
     CROSS JOIN tenant_settings ts
     WHERE r.id = $1 FOR UPDATE OF r`,
    [runId],
  );
  const run = rows[0];
  // Redelivery after success (or a run that was never confirmed): nothing to do.
  if (!run || run.status !== 'confirmed' || !run.payload_enc || run.payload_key_version === null) {
    return 'skipped';
  }
  const grid = openGrid(keyring, tenantId, runId, {
    ciphertext: run.payload_enc,
    keyVersion: run.payload_key_version,
  });
  const mapping = mappingSchema.parse(run.mapping);
  const results = validateRows(grid, mapping, { currency: run.currency, country: run.country });
  const counts: Counts = { created: 0, updated: 0, unchanged: 0, customers: 0, exceptions: 0 };
  const customers = new Map<string, string | null>();
  const rulesCache = new Map<string, PartyRules>();
  const ctx = {
    id: runId,
    sourceId: run.source_id,
    companyId: run.company_id,
    today: run.today,
    timezone: run.timezone,
  };
  for (const r of results) {
    if (r.ok) {
      await applyRow(db, keyring, ctx, r.rowNumber, r.value, customers, rulesCache, counts);
    }
  }
  // 6.1: mapped custom fields, after the rows exist (invoice by its source key, its customer).
  const custom = await applyCustomFields(db, audit, keyring, run.source_id, mapping, results);
  await db.query(
    `UPDATE import_runs SET status = 'completed', completed_at = now(), payload_enc = NULL,
            payload_key_version = NULL, invoices_created = $2, invoices_updated = $3,
            invoices_unchanged = $4, customers_created = $5, exceptions_count = $6
     WHERE id = $1`,
    [runId, counts.created, counts.updated, counts.unchanged, counts.customers, counts.exceptions],
  );
  await audit({
    action: 'import.completed',
    entityType: 'import_runs',
    entityId: runId,
    after: {
      invoices_created: counts.created,
      invoices_updated: counts.updated,
      invoices_unchanged: counts.unchanged,
      customers_created: counts.customers,
      exceptions: counts.exceptions,
      custom_values: custom.applied,
      custom_skipped: custom.skipped,
    },
  });
  await emitEvent(db, {
    eventType: 'import.completed',
    aggregateType: 'import_runs',
    aggregateId: runId,
    payload: { invoices_created: counts.created, exceptions: counts.exceptions },
  });
  return 'applied';
}

/**
 * Rollback (2.2): invoices created by the run that nobody touched since are removed, together
 * with the source settlements of the run; a settlement the run made on an older invoice is
 * reverted when nothing was allocated to that invoice after it. Everything else → exception
 * `rollback_blocked`. Customers created by the run and metadata updates stay (NEXT.md).
 */
export async function rollbackImport(
  ctx: TenantContext,
  runId: string,
): Promise<{ reverted: number; blocked: number }> {
  await ctx.requirePermission('import.create');
  const { rows } = await ctx.db.query<{ status: string }>(
    'SELECT status FROM import_runs WHERE id = $1 FOR UPDATE',
    [runId],
  );
  if (!rows[0]) throw new NotFoundError();
  if (rows[0].status !== 'completed') throw new ConflictError('conflict');

  let reverted = 0;
  let blocked = 0;
  const created = await ctx.db.query<{ id: string; untouched: boolean }>(
    `SELECT i.id,
            i.last_import_run_id = $1
            AND NOT EXISTS (SELECT 1 FROM case_invoices ci WHERE ci.invoice_id = i.id)
            AND NOT EXISTS (SELECT 1 FROM payment_allocations a JOIN payments p ON p.id = a.payment_id
                            WHERE a.invoice_id = i.id AND p.import_run_id IS DISTINCT FROM $1) AS untouched
     FROM invoices i WHERE i.import_run_id = $1 FOR UPDATE OF i`,
    [runId],
  );
  for (const inv of created.rows) {
    if (!inv.untouched) {
      await exception(ctx.db, runId, null, inv.id, 'rollback_blocked');
      blocked += 1;
      continue;
    }
    const settlements = await ctx.db.query<{ payment_id: string }>(
      'DELETE FROM payment_allocations WHERE invoice_id = $1 RETURNING payment_id',
      [inv.id],
    );
    for (const s of settlements.rows)
      await ctx.db.query('DELETE FROM payments WHERE id = $1', [s.payment_id]);
    await ctx.db.query('DELETE FROM invoices WHERE id = $1', [inv.id]);
    reverted += 1;
  }

  // Settlements this run made on invoices it did not create.
  const older = await ctx.db.query<{
    allocation_id: string;
    payment_id: string;
    invoice_id: string;
    revertible: boolean;
  }>(
    `SELECT a.id AS allocation_id, p.id AS payment_id, a.invoice_id,
            i.last_import_run_id = $1
            AND NOT EXISTS (SELECT 1 FROM payment_allocations later
                            WHERE later.invoice_id = a.invoice_id AND later.created_at > a.created_at) AS revertible
     FROM payments p
     JOIN payment_allocations a ON a.payment_id = p.id
     JOIN invoices i ON i.id = a.invoice_id
     WHERE p.import_run_id = $1 AND p.kind = 'source_settlement'`,
    [runId],
  );
  for (const s of older.rows) {
    if (!s.revertible) {
      await exception(ctx.db, runId, null, s.invoice_id, 'rollback_blocked');
      blocked += 1;
      continue;
    }
    await ctx.db.query('DELETE FROM payment_allocations WHERE id = $1', [s.allocation_id]);
    await ctx.db.query('DELETE FROM payments WHERE id = $1', [s.payment_id]);
    reverted += 1;
  }

  await ctx.db.query(
    `UPDATE import_runs SET status = 'rolled_back', rolled_back_at = now(), rolled_back_by = $2,
            exceptions_count = exceptions_count + $3, updated_by = $2
     WHERE id = $1`,
    [runId, ctx.userId, blocked],
  );
  await ctx.audit({
    action: 'import.rolled_back',
    entityType: 'import_runs',
    entityId: runId,
    after: { reverted, blocked },
  });
  await emitEvent(ctx.db, {
    eventType: 'import.rolled_back',
    aggregateType: 'import_runs',
    aggregateId: runId,
    payload: { reverted, blocked },
    requestId: ctx.requestId,
    actorId: ctx.userId,
  });
  return { reverted, blocked };
}

async function applyCustomFields(
  db: Parameters<typeof applyImport>[0],
  audit: Parameters<typeof applyImport>[1],
  keyring: MasterKeyring,
  sourceId: string,
  mapping: Mapping,
  results: RowResult[],
): Promise<{ applied: number; skipped: number }> {
  const targets = Object.keys(mapping.custom ?? {});
  const out = { applied: 0, skipped: 0 };
  if (!targets.length) return out;
  const defs = await listDefinitions({ db } as Pick<TenantContext, 'db'>);
  // setValues as the import job: no member (the run checked import.create), job audit.
  const ctx = { db, userId: null, audit, requestId: null } as unknown as TenantContext;
  for (const r of results) {
    if (!r.ok || !Object.keys(r.value.custom).length) continue;
    const { rows } = await db.query<{ id: string; customer_id: string; currency: string }>(
      'SELECT id, customer_id, currency FROM invoices WHERE source_id = $1 AND external_id = $2',
      [sourceId, r.value.externalId],
    );
    const inv = rows[0];
    if (!inv) continue;
    const byEntity: Record<'customer' | 'invoice', Record<string, unknown>> = {
      customer: {},
      invoice: {},
    };
    for (const [target, cell] of Object.entries(r.value.custom)) {
      const [entity, key] = target.split('.') as ['customer' | 'invoice', string];
      const def = defs.find((d) => d.entityType === entity && d.key === key);
      const value = def
        ? fromImportCell(def, cell, {
            amount: (v) => normalizeAmount(v, mapping.decimal),
            date: (v) => normalizeDate(v, mapping.dateOrder),
            yesNo: (v) => {
              const b = parseYesNo(v);
              return b === 'invalid' ? null : b;
            },
            currency: inv.currency,
          })
        : null;
      if (value === null) out.skipped += 1;
      else byEntity[entity][key] = value;
    }
    for (const entity of ['customer', 'invoice'] as const) {
      const values = byEntity[entity];
      if (!Object.keys(values).length) continue;
      await db.query('SAVEPOINT import_cf');
      try {
        const res = await setValues(
          ctx,
          entity,
          entity === 'customer' ? inv.customer_id : inv.id,
          values,
          keyring,
          { skipPermission: true },
        );
        await db.query('RELEASE SAVEPOINT import_cf');
        out.applied += res.changed.length;
      } catch {
        await db.query('ROLLBACK TO SAVEPOINT import_cf');
        out.skipped += Object.keys(values).length;
      }
    }
  }
  return out;
}
