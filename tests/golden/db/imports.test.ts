import { randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeAudit } from '@/server/auth/audit';
import type { TenantContext } from '@/server/auth/with-tenant';
import { parseMasterKeyring } from '@/server/crypto/keyring';
import { applyImport, rollbackImport } from '@/server/imports/process';
import { confirmImport, getImport, uploadImport, validateImport } from '@/server/imports/service';
import { customerPayments, getDashboard } from '@/server/receivables/service';
import { ensureFixtures, FX } from './fixtures';
import { appPool, closePools, inTenant, inTenantCommit, migratePool } from './helpers';

// Golden (never delete or skip) — task 2.2: import idempotency ((source, external_id) is one
// invoice), amount_open only through allocations (lower open amount → source settlement),
// money changes → reconciliation exceptions, rollback of untouched rows, encrypted payload
// dropped at the end, row errors without values, tenant isolation of runs.
// Permission gates of the routes: tests/golden/api-routes.test.ts + with-tenant tests.

const keyring = parseMasterKeyring(`1:${randomBytes(32).toString('base64')}`);
const TAX = `IMP${randomUUID().slice(0, 8)}`;

beforeAll(async () => {
  await ensureFixtures();
  await inTenantCommit(migratePool, FX.tenantA, async (c) => {
    await c.query('SELECT provision_receivables_defaults()');
  });
});
afterAll(closePools);

function ctxFor(db: PoolClient): TenantContext {
  const requestId = randomUUID();
  return {
    db,
    tenantId: FX.tenantA,
    userId: FX.userA,
    authUserId: 'golden',
    requestId,
    requirePermission: async (key) => ({ key, scope: 'ORGANIZATION' }),
    requireAnyPermission: async (keys) => ({ key: keys[0] ?? '', scope: 'ORGANIZATION' }),
    audit: (entry) => writeAudit(db, { type: 'user', id: FX.userA }, entry, requestId),
  };
}

const csv = (lines: string[]) => Buffer.from(lines.join('\r\n'), 'utf8').toString('base64');
// Review S-02: the test country has no identifier rules, so the file says "company" (ne).
const HEADER = 'ID;Broj fakture;Datum fakture;Datum dospeća;Iznos;Saldo;PIB;Naziv kupca;Fizičko lice';

async function runImport(ctx: TenantContext, lines: string[]) {
  const up = await uploadImport(
    ctx,
    { fileName: 'f.csv', format: 'csv', content: csv(lines) },
    keyring,
  );
  const preview = await validateImport(ctx, up.id, { mapping: up.mapping }, keyring);
  await confirmImport(ctx, up.id);
  const applied = await applyImport(ctx.db, ctx.audit, keyring, FX.tenantA, up.id);
  return { id: up.id, up, preview, applied };
}

async function invoice(db: PoolClient, externalId: string) {
  const { rows } = await db.query<{
    id: string;
    amount_total: string;
    amount_open: string;
    accounting_status: string;
    due_date: string;
  }>(
    `SELECT i.id, i.amount_total, i.amount_open, i.accounting_status, i.due_date::text AS due_date
     FROM invoices i JOIN data_sources s ON s.id = i.source_id
     WHERE s.name = 'file-import' AND i.external_id = $1`,
    [externalId],
  );
  return rows[0];
}

describe('golden/db: invoice import', () => {
  it('upload → detection → validation → confirm → worker; errors as codes only', async () => {
    const out = await inTenant(appPool, FX.tenantA, async (db) => {
      const ctx = ctxFor(db);
      const run = await runImport(ctx, [
        HEADER,
        `${TAX}-1;F-1;01.09.2026;30.09.2026;1.000,00;1.000,00;${TAX}A;Alfa d.o.o.;ne`,
        `${TAX}-2;F-2;01.09.2026;31.10.2026;500,00;200,00;${TAX}A;Alfa d.o.o.;ne`,
        `${TAX}-3;F-3;bad;31.10.2026;500,00;;${TAX}B;Beta d.o.o.;ne`,
      ]);
      const report = await getImport(ctx, run.id);
      const payload = await db.query('SELECT payload_enc FROM import_runs WHERE id = $1', [run.id]);
      const event = await db.query(
        `SELECT 1 FROM domain_events WHERE aggregate_id = $1 AND event_type = 'import.confirmed'`,
        [run.id],
      );
      return {
        detected: run.up.mapping.columns,
        decimal: run.up.mapping.decimal,
        preview: [run.preview.rowsValid, run.preview.rowsInvalid],
        applied: run.applied,
        report,
        payload: payload.rows[0]?.payload_enc,
        event: event.rowCount,
        f1: await invoice(db, `${TAX}-1`),
        f2: await invoice(db, `${TAX}-2`),
      };
    });
    expect(out.detected).toMatchObject({
      external_id: 0,
      number: 1,
      amount_total: 4,
      amount_open: 5,
      customer_tax_id: 6,
    });
    expect(out.decimal).toBe('comma');
    expect(out.preview).toEqual([2, 1]);
    expect(out.applied).toBe('applied');
    expect(out.event).toBe(1);
    expect(out.payload).toBeNull();
    expect(out.report).toMatchObject({
      status: 'completed',
      invoicesCreated: 2,
      customersCreated: 1,
      exceptionsCount: 0,
      errors: [{ rowNumber: 4, field: 'issue_date', code: 'invalid_date' }],
    });
    expect(out.f1).toMatchObject({
      amount_total: '1000.00',
      amount_open: '1000.00',
      accounting_status: 'open',
    });
    // Saldo 200 of 500 → a source settlement of 300, amount_open derived.
    expect(out.f2).toMatchObject({
      amount_total: '500.00',
      amount_open: '200.00',
      accounting_status: 'partially_paid',
    });
  });

  it('same external_id = update, never a duplicate; money changes become exceptions; redelivery is a no-op', async () => {
    const out = await inTenant(appPool, FX.tenantA, async (db) => {
      const ctx = ctxFor(db);
      await runImport(ctx, [
        HEADER,
        `${TAX}-1;F-1;01.09.2026;30.09.2026;1.000,00;1.000,00;${TAX}A;Alfa d.o.o.;ne`,
        `${TAX}-2;F-2;01.09.2026;31.10.2026;500,00;0,00;${TAX}A;Alfa d.o.o.;ne`,
      ]);
      const second = await runImport(ctx, [
        HEADER,
        `${TAX}-1;F-1;01.09.2026;15.10.2026;1.000,00;600,00;${TAX}A;Alfa d.o.o.;ne`, // lower open, new due
        `${TAX}-2;F-2;01.09.2026;31.10.2026;550,00;550,00;${TAX}A;Alfa d.o.o.;ne`, // paid invoice changed
        `${TAX}-4;F-4;01.10.2026;31.10.2026;80,00;;${TAX}A;Alfa d.o.o.;ne`, // new
      ]);
      const again = await applyImport(db, ctx.audit, keyring, FX.tenantA, second.id);
      const count = await db.query(
        `SELECT count(*)::int AS n FROM invoices WHERE external_id LIKE $1`,
        [`${TAX}-%`],
      );
      return {
        report: await getImport(ctx, second.id),
        again,
        count: count.rows[0]?.n,
        f1: await invoice(db, `${TAX}-1`),
      };
    });
    expect(out.again).toBe('skipped');
    expect(out.count).toBe(3);
    expect(out.f1).toMatchObject({
      amount_open: '600.00',
      due_date: '2026-10-15',
      accounting_status: 'partially_paid',
    });
    expect(out.report).toMatchObject({
      invoicesCreated: 1,
      invoicesUpdated: 1,
      exceptionsCount: 1,
    });
    expect(out.report.exceptions).toEqual([
      expect.objectContaining({
        kind: 'paid_invoice_changed',
        rowNumber: 3,
        oldAmount: '500.00',
        newAmount: '550.00',
        currency: 'EUR',
      }),
    ]);
  });

  it('a lower open amount is an ADJUSTMENT (reason unknown): never "collected", added back for DSO', async () => {
    const out = await inTenant(appPool, FX.tenantA, async (db) => {
      const ctx = ctxFor(db);
      const before = await getDashboard(ctx);
      await runImport(ctx, [HEADER, `${TAX}-11;F-11;01.09.2026;30.09.2026;100,00;100,00;${TAX}A;Alfa;ne`]);
      const mid = await getDashboard(ctx);
      await runImport(ctx, [HEADER, `${TAX}-11;F-11;01.09.2026;30.09.2026;100,00;25,00;${TAX}A;Alfa;ne`]);
      const after = await getDashboard(ctx);
      const customer = await db.query<{ customer_id: string }>(
        'SELECT customer_id FROM invoices WHERE external_id = $1',
        [`${TAX}-11`],
      );
      const payments = await customerPayments(ctx, customer.rows[0]?.customer_id ?? '');
      return { before, mid, after, payments };
    });
    expect(out.after.collected30).toBe(out.before.collected30);
    expect(out.after.collected30).toBe(out.mid.collected30);
    expect(out.payments).toEqual([
      expect.objectContaining({ kind: 'adjustment', reason: 'unknown', amount: '75.00' }),
    ]);
    // The open total drops by 75, the DSO numerator does not (adjustment added back).
    expect(out.after.dso).toBe(out.mid.dso);
  });

  it('a higher open amount on an unpaid invoice is an exception, not a rewrite', async () => {
    const out = await inTenant(appPool, FX.tenantA, async (db) => {
      const ctx = ctxFor(db);
      await runImport(ctx, [
        HEADER,
        `${TAX}-5;F-5;01.09.2026;30.09.2026;100,00;40,00;${TAX}A;Alfa;ne`,
      ]);
      const second = await runImport(ctx, [
        HEADER,
        `${TAX}-5;F-5;01.09.2026;30.09.2026;100,00;70,00;${TAX}A;Alfa;ne`,
      ]);
      return { report: await getImport(ctx, second.id), f5: await invoice(db, `${TAX}-5`) };
    });
    expect(out.f5?.amount_open).toBe('40.00');
    expect(out.report.exceptions).toEqual([
      expect.objectContaining({ kind: 'open_amount_increased' }),
    ]);
  });

  it('rollback removes untouched invoices and reverts settlements; touched ones become exceptions', async () => {
    const out = await inTenant(appPool, FX.tenantA, async (db) => {
      const ctx = ctxFor(db);
      await runImport(ctx, [
        HEADER,
        `${TAX}-6;F-6;01.09.2026;30.09.2026;300,00;300,00;${TAX}A;Alfa;ne`,
      ]);
      const second = await runImport(ctx, [
        HEADER,
        `${TAX}-6;F-6;01.09.2026;30.09.2026;300,00;100,00;${TAX}A;Alfa;ne`, // settlement 200 on an older invoice
        `${TAX}-7;F-7;01.09.2026;30.09.2026;50,00;50,00;${TAX}A;Alfa;ne`, // created, untouched
        `${TAX}-8;F-8;01.09.2026;30.09.2026;70,00;70,00;${TAX}A;Alfa;ne`, // created, then put into a case
      ]);
      const f8 = await invoice(db, `${TAX}-8`);
      const customer = await db.query<{ customer_id: string }>(
        'SELECT customer_id FROM invoices WHERE id = $1',
        [f8?.id],
      );
      const kase = await db.query<{ id: string }>(
        `INSERT INTO collection_cases (tenant_id, customer_id, stage_code) VALUES ($1, $2, 'new') RETURNING id`,
        [FX.tenantA, customer.rows[0]?.customer_id],
      );
      await db.query(
        `INSERT INTO case_invoices (tenant_id, case_id, invoice_id) VALUES ($1, $2, $3)`,
        [FX.tenantA, kase.rows[0]?.id, f8?.id],
      );
      const result = await rollbackImport(ctx, second.id);
      return {
        result,
        report: await getImport(ctx, second.id),
        f6: await invoice(db, `${TAX}-6`),
        f7: await invoice(db, `${TAX}-7`),
        f8: await invoice(db, `${TAX}-8`),
      };
    });
    expect(out.result).toEqual({ reverted: 2, blocked: 1 });
    expect(out.report.status).toBe('rolled_back');
    expect(out.report.exceptions).toEqual([expect.objectContaining({ kind: 'rollback_blocked' })]);
    expect(out.f6?.amount_open).toBe('300.00');
    expect(out.f7).toBeUndefined();
    expect(out.f8).toBeDefined();
  });

  it('another tenant sees no run, no row error and no exception', async () => {
    const id = await inTenant(appPool, FX.tenantA, async (db) => {
      const ctx = ctxFor(db);
      const run = await runImport(ctx, [
        HEADER,
        `${TAX}-9;F-9;01.09.2026;bad;1,00;;${TAX}A;Alfa;ne`,
        `${TAX}-10;F-10;01.09.2026;30.09.2026;1,00;;${TAX}A;Alfa;ne`,
      ]);
      await db.query("SELECT set_config('app.tenant_id', $1, true)", [FX.tenantB]);
      const seen = await db.query(
        `SELECT (SELECT count(*) FROM import_runs WHERE id = $1) + (SELECT count(*) FROM import_row_errors)
              + (SELECT count(*) FROM reconciliation_exceptions) AS n`,
        [run.id],
      );
      return Number(seen.rows[0]?.n);
    });
    expect(id).toBe(0);
  });

  it('row errors and run reports have no column that could carry a cell value', async () => {
    const res = await inTenant(migratePool, null, (c) =>
      c.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'import_row_errors' ORDER BY ordinal_position`,
      ),
    );
    expect(res.rows.map((r) => r.column_name)).toEqual([
      'id',
      'tenant_id',
      'run_id',
      'row_number',
      'field',
      'error_code',
      'created_at',
    ]);
  });
});
