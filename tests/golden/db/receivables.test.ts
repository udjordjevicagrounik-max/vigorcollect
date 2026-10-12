import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { storeRates } from '@/server/fx/rates-job';
import { ensureFixtures, FX } from './fixtures';
import { appPool, closePools, inTenant, migratePool, savepointState, workerPool } from './helpers';

// Golden (never delete or skip): receivables (migration 012) — tenant isolation, IDOR through
// composite FKs, amount_open derived from allocations only, Σ allocations ≤ payment, frozen FX
// (rule 18), configurable tenant defaults.

beforeAll(ensureFixtures);
afterAll(closePools);

/** The single row of a RETURNING id. */
function idOf(res: { rows: { id: string }[] }): string {
  const id = res.rows[0]?.id;
  if (!id) throw new Error('expected one row');
  return id;
}

type World = { sourceId: string; invoiceId: string; paymentId: string };

/** Data source + one 1000.00 EUR invoice + one 600.00 EUR payment, inside the test transaction. */
async function world(c: PoolClient, tenantId: string, companyId: string, customerId: string): Promise<World> {
  const source = await c.query<{ id: string }>(
    `INSERT INTO data_sources (tenant_id, name, source_type) VALUES ($1, 'golden-erp', 'ERP') RETURNING id`,
    [tenantId],
  );
  const sourceId = idOf(source);
  const invoice = await c.query<{ id: string }>(
    `INSERT INTO invoices (tenant_id, company_id, customer_id, source_id, external_id, number,
                           issue_date, due_date, currency, amount_total, amount_open)
     VALUES ($1, $2, $3, $4, 'INV-1', 'F-1', '2026-09-01', '2026-09-30', 'EUR', '1000.00', '1000.00')
     RETURNING id`,
    [tenantId, companyId, customerId, sourceId],
  );
  const payment = await c.query<{ id: string }>(
    `INSERT INTO payments (tenant_id, customer_id, source_id, external_id, paid_on, amount, currency)
     VALUES ($1, $2, $3, 'PAY-1', '2026-10-01', '600.00', 'EUR') RETURNING id`,
    [tenantId, customerId, sourceId],
  );
  return { sourceId, invoiceId: idOf(invoice), paymentId: idOf(payment) };
}

const worldA = (c: PoolClient) => world(c, FX.tenantA, FX.companyA, FX.customerA);

async function invoiceState(c: PoolClient, id: string) {
  const res = await c.query<{ amount_open: string; accounting_status: string }>(
    'SELECT amount_open, accounting_status FROM invoices WHERE id = $1',
    [id],
  );
  return res.rows[0];
}

describe('golden/db: receivables tenant isolation and IDOR', () => {
  it('tenant B never sees tenant A invoices, payments or allocations', async () => {
    const counts = await inTenant(appPool, FX.tenantA, async (c) => {
      const w = await worldA(c);
      await c.query(
        `INSERT INTO payment_allocations (tenant_id, payment_id, invoice_id, amount, method)
         VALUES ($1, $2, $3, '100.00', 'explicit')`,
        [FX.tenantA, w.paymentId, w.invoiceId],
      );
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [FX.tenantB]);
      const q = (t: string) => c.query(`SELECT 1 FROM ${t}`).then((r) => r.rowCount);
      return [await q('invoices'), await q('payments'), await q('payment_allocations')];
    });
    expect(counts).toEqual([0, 0, 0]);
  });

  it('an invoice for another tenant’s customer, company or source fails the composite FK', async () => {
    const states = await inTenant(appPool, FX.tenantA, async (c) => {
      const w = await worldA(c);
      const insert = (company: string, customer: string) =>
        savepointState(
          c,
          `INSERT INTO invoices (tenant_id, company_id, customer_id, source_id, external_id, number,
                                 issue_date, due_date, currency, amount_total, amount_open)
           VALUES ($1, $2, $3, $4, 'X', 'X', '2026-09-01', '2026-09-30', 'EUR', '1.00', '1.00')`,
          [FX.tenantA, company, customer, w.sourceId],
        );
      return [await insert(FX.companyB, FX.customerA), await insert(FX.companyA, FX.customerB)];
    });
    expect(states).toEqual(['23503', '23503']);
  });

  it('a row tagged with another tenant is rejected by RLS WITH CHECK', async () => {
    const state = await inTenant(appPool, FX.tenantA, (c) =>
      savepointState(
        c,
        `INSERT INTO promises (tenant_id, customer_id, company_id, amount, currency, promised_on, made_on)
         VALUES ($1, $2, $3, '1.00', 'EUR', '2026-10-20', '2026-10-12')`,
        [FX.tenantB, FX.customerB, FX.companyB],
      ),
    );
    expect(state).toBe('42501');
  });

  it('without tenant context no receivables row is visible', async () => {
    const rows = await inTenant(appPool, null, (c) =>
      c.query(
        `SELECT (SELECT count(*) FROM invoices) + (SELECT count(*) FROM payments)
              + (SELECT count(*) FROM promises) + (SELECT count(*) FROM activities) AS n`,
      ),
    );
    expect(Number(rows.rows[0].n)).toBe(0);
  });
});

describe('golden/db: amount_open is derived, never written', () => {
  it('a manual amount_open is overwritten on insert and on update', async () => {
    const states = await inTenant(appPool, FX.tenantA, async (c) => {
      const w = await worldA(c);
      await c.query("UPDATE invoices SET amount_open = '1.00' WHERE id = $1", [w.invoiceId]);
      return invoiceState(c, w.invoiceId);
    });
    expect(states).toEqual({ amount_open: '1000.00', accounting_status: 'open' });
  });

  it('allocations drive amount_open and the accounting status (partial → paid → back)', async () => {
    const trail = await inTenant(appPool, FX.tenantA, async (c) => {
      const w = await worldA(c);
      const out = [];
      await c.query(
        `INSERT INTO payment_allocations (tenant_id, payment_id, invoice_id, amount, method)
         VALUES ($1, $2, $3, '600.00', 'fifo')`,
        [FX.tenantA, w.paymentId, w.invoiceId],
      );
      out.push(await invoiceState(c, w.invoiceId));
      const second = await c.query<{ id: string }>(
        `INSERT INTO payments (tenant_id, customer_id, source_id, paid_on, amount, currency)
         VALUES ($1, $2, $3, '2026-10-02', '400.00', 'EUR') RETURNING id`,
        [FX.tenantA, FX.customerA, w.sourceId],
      );
      await c.query(
        `INSERT INTO payment_allocations (tenant_id, payment_id, invoice_id, amount, method)
         VALUES ($1, $2, $3, '400.00', 'fifo')`,
        [FX.tenantA, idOf(second), w.invoiceId],
      );
      out.push(await invoiceState(c, w.invoiceId));
      await c.query('DELETE FROM payment_allocations WHERE payment_id = $1', [idOf(second)]);
      out.push(await invoiceState(c, w.invoiceId));
      return out;
    });
    expect(trail).toEqual([
      { amount_open: '400.00', accounting_status: 'partially_paid' },
      { amount_open: '0.00', accounting_status: 'paid' },
      { amount_open: '400.00', accounting_status: 'partially_paid' },
    ]);
  });

  it('allocations above the payment amount or the invoice total are rejected', async () => {
    const states = await inTenant(appPool, FX.tenantA, async (c) => {
      const w = await worldA(c);
      const alloc = (paymentId: string, amount: string) =>
        savepointState(
          c,
          `INSERT INTO payment_allocations (tenant_id, payment_id, invoice_id, amount, method)
           VALUES ($1, $2, $3, $4, 'explicit')`,
          [FX.tenantA, paymentId, w.invoiceId, amount],
        );
      const overPayment = await alloc(w.paymentId, '600.01');
      const big = await c.query<{ id: string }>(
        `INSERT INTO payments (tenant_id, customer_id, source_id, paid_on, amount, currency)
         VALUES ($1, $2, $3, '2026-10-02', '5000.00', 'EUR') RETURNING id`,
        [FX.tenantA, FX.customerA, w.sourceId],
      );
      const overInvoice = await alloc(idOf(big), '1000.01');
      const exact = await alloc(idOf(big), '1000.00');
      return [overPayment, overInvoice, exact];
    });
    expect(states).toEqual(['23514', '23514', 'OK']);
  });

  it('an allocation across currencies or customers is rejected', async () => {
    const states = await inTenant(appPool, FX.tenantA, async (c) => {
      const w = await worldA(c);
      const rsd = await c.query<{ id: string }>(
        `INSERT INTO payments (tenant_id, customer_id, source_id, paid_on, amount, currency)
         VALUES ($1, $2, $3, '2026-10-02', '100.00', 'RSD') RETURNING id`,
        [FX.tenantA, FX.customerA, w.sourceId],
      );
      return savepointState(
        c,
        `INSERT INTO payment_allocations (tenant_id, payment_id, invoice_id, amount, method)
         VALUES ($1, $2, $3, '10.00', 'explicit')`,
        [FX.tenantA, idOf(rsd), w.invoiceId],
      );
    });
    expect(states).toBe('23514');
  });

  it('the app cannot edit an allocation, re-value or delete a payment', async () => {
    const states = await inTenant(appPool, FX.tenantA, async (c) => {
      const w = await worldA(c);
      await c.query(
        `INSERT INTO payment_allocations (tenant_id, payment_id, invoice_id, amount, method)
         VALUES ($1, $2, $3, '100.00', 'explicit')`,
        [FX.tenantA, w.paymentId, w.invoiceId],
      );
      return [
        await savepointState(c, "UPDATE payment_allocations SET amount = '600.00'"),
        await savepointState(c, "UPDATE payments SET amount = '9999.00' WHERE id = $1", [w.paymentId]),
        await savepointState(c, 'DELETE FROM payments WHERE id = $1', [w.paymentId]),
      ];
    });
    expect(states).toEqual(['42501', '23514', '42501']);
  });

  it('the same external_id from the same source is never a duplicate invoice', async () => {
    const state = await inTenant(appPool, FX.tenantA, async (c) => {
      const w = await worldA(c);
      return savepointState(
        c,
        `INSERT INTO invoices (tenant_id, company_id, customer_id, source_id, external_id, number,
                               issue_date, due_date, currency, amount_total, amount_open)
         VALUES ($1, $2, $3, $4, 'INV-1', 'F-1b', '2026-09-01', '2026-09-30', 'EUR', '5.00', '5.00')`,
        [FX.tenantA, FX.companyA, FX.customerA, w.sourceId],
      );
    });
    expect(state).toBe('23505');
  });
});

describe('golden/db: frozen FX (rule 18)', () => {
  it('a set exchange rate on an invoice or payment is never rewritten', async () => {
    const states = await inTenant(appPool, FX.tenantA, async (c) => {
      const w = await worldA(c);
      const setFx = (table: string, id: string, rate: string) =>
        savepointState(
          c,
          `UPDATE ${table} SET fx_rate = $2, fx_rate_date = '2026-09-01', fx_source = 'ECB' WHERE id = $1`,
          [id, rate],
        );
      return [
        await setFx('invoices', w.invoiceId, '117.1500000000'),
        await setFx('invoices', w.invoiceId, '117.2000000000'),
        await setFx('payments', w.paymentId, '117.1500000000'),
        await setFx('payments', w.paymentId, '117.2000000000'),
        await savepointState(c, "UPDATE invoices SET currency = 'RSD' WHERE id = $1", [w.invoiceId]),
      ];
    });
    expect(states).toEqual(['OK', '23514', 'OK', '23514', '23514']);
  });

  it('rate, date and source are set together or not at all', async () => {
    const state = await inTenant(appPool, FX.tenantA, async (c) => {
      const w = await worldA(c);
      return savepointState(c, "UPDATE invoices SET fx_rate = '1.5' WHERE id = $1", [w.invoiceId]);
    });
    expect(state).toBe('23514');
  });

  it('the app cannot write exchange rates; the worker only through fx_rates_upsert()', async () => {
    const app = await inTenant(appPool, FX.tenantA, (c) =>
      savepointState(
        c,
        `INSERT INTO exchange_rates (source, base_currency, quote_currency, rate, valid_on)
         VALUES ('ECB', 'EUR', 'RSD', 117, '2000-01-01')`,
      ),
    );
    const worker = await inTenant(workerPool(), null, async (c) => {
      const direct = await savepointState(
        c,
        `INSERT INTO exchange_rates (source, base_currency, quote_currency, rate, valid_on)
         VALUES ('ECB', 'EUR', 'RSD', 117, '2000-01-01')`,
      );
      const first = await c.query<{ ok: boolean }>(
        "SELECT fx_rates_upsert('ECB', 'EUR', 'RSD', 117.1234, '2000-01-01') AS ok",
      );
      const again = await c.query<{ ok: boolean }>(
        "SELECT fx_rates_upsert('ECB', 'EUR', 'RSD', 999, '2000-01-01') AS ok",
      );
      return [direct, first.rows[0]?.ok, again.rows[0]?.ok];
    });
    expect(app).toBe('42501');
    expect(worker).toEqual(['42501', true, false]);
  });

  it('fxRatesJob stores a set once; a later different rate for the same day is ignored', async () => {
    const set = (rate: string) => ({
      source: 'ECB',
      base: 'EUR',
      validOn: '2000-01-03',
      rates: [{ quote: 'USD', rate }],
    });
    const counts = await inTenant(workerPool(), null, async (c) => [
      await storeRates(c, set('1.0812')),
      await storeRates(c, set('1.0900')),
    ]);
    expect(counts).toEqual([1, 0]);
  });
});

describe('golden/db: collection cases, promises, activities', () => {
  it('the legal stage needs an approved handover request (rule 11)', async () => {
    const state = await inTenant(migratePool, FX.tenantA, async (c) => {
      await c.query('SELECT provision_receivables_defaults()');
      return savepointState(
        c,
        `INSERT INTO collection_cases (tenant_id, customer_id, stage_code) VALUES ($1, $2, 'legal')`,
        [FX.tenantA, FX.customerA],
      );
    });
    expect(state).toBe('23514');
  });

  it('an unknown stage code fails the code_lists FK', async () => {
    const state = await inTenant(migratePool, FX.tenantA, async (c) => {
      await c.query('SELECT provision_receivables_defaults()');
      return savepointState(
        c,
        `INSERT INTO collection_cases (tenant_id, customer_id, stage_code) VALUES ($1, $2, 'nope')`,
        [FX.tenantA, FX.customerA],
      );
    });
    expect(state).toBe('23503');
  });

  it('activities are append-only for the app; a note is stored only encrypted', async () => {
    const states = await inTenant(appPool, FX.tenantA, async (c) => {
      const a = await c.query<{ id: string }>(
        `INSERT INTO activities (tenant_id, customer_id, kind, actor_user_id, note_enc, note_key_version)
         VALUES ($1, $2, 'note', $3, '\\x01', 1) RETURNING id`,
        [FX.tenantA, FX.customerA, FX.userA],
      );
      return [
        await savepointState(c, "UPDATE activities SET kind = 'call' WHERE id = $1", [idOf(a)]),
        await savepointState(c, 'DELETE FROM activities WHERE id = $1', [idOf(a)]),
        await savepointState(
          c,
          `INSERT INTO activities (tenant_id, customer_id, kind, actor_user_id, note_enc)
           VALUES ($1, $2, 'note', $3, '\\x01')`,
          [FX.tenantA, FX.customerA, FX.userA],
        ),
      ];
    });
    expect(states).toEqual(['42501', '42501', '23514']);
  });
});

describe('golden/db: tenant receivables defaults are configuration', () => {
  it('provisioning seeds six aging buckets 0 / 1–30 / 31–60 / 61–90 / 91–180 / 180+ and is idempotent', async () => {
    const rows = await inTenant(migratePool, FX.tenantB, async (c) => {
      await c.query('SELECT provision_receivables_defaults()');
      await c.query('SELECT provision_receivables_defaults()');
      const res = await c.query<{ code: string; min: number; max: number | null }>(
        `SELECT code, min_days_overdue AS min, max_days_overdue AS max
         FROM aging_bucket_bounds ORDER BY min_days_overdue`,
      );
      return res.rows;
    });
    expect(rows).toEqual([
      { code: 'current', min: 0, max: 0 },
      { code: 'd1_30', min: 1, max: 30 },
      { code: 'd31_60', min: 31, max: 60 },
      { code: 'd61_90', min: 61, max: 90 },
      { code: 'd91_180', min: 91, max: 180 },
      { code: 'd181_plus', min: 181, max: null },
    ]);
  });

  it('promise grace and DSO window default to 1 and 90 days in tenant_settings', async () => {
    const row = await inTenant(appPool, FX.tenantA, (c) =>
      c.query('SELECT promise_grace_days, dso_window_days, allocation_strategy FROM tenant_settings'),
    );
    expect(row.rows[0]).toEqual({ promise_grace_days: 1, dso_window_days: 90, allocation_strategy: 'fifo_due' });
  });

  it('provisioning without a tenant context is refused', async () => {
    const state = await inTenant(migratePool, null, (c) =>
      savepointState(c, 'SELECT provision_receivables_defaults()'),
    );
    expect(state).toBe('42501');
  });
});

describe('golden/db: no float column anywhere (rule 18)', () => {
  it('no real / double precision column in the public schema; amounts are numeric(18,2)', async () => {
    const res = await inTenant(migratePool, null, (c) =>
      c.query<{ col: string; type: string }>(
        `SELECT table_name || '.' || column_name AS col, data_type ||
                coalesce('(' || numeric_precision || ',' || numeric_scale || ')', '') AS type
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND (data_type IN ('real', 'double precision', 'money')
                OR (column_name ~ '^(amount|paid_amount)' AND (data_type, numeric_precision, numeric_scale)
                    IS DISTINCT FROM ('numeric', 18, 2)))`,
      ),
    );
    expect(res.rows).toEqual([]);
  });
});
