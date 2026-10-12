import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeAudit } from '@/server/auth/audit';
import type { Scope } from '@/server/auth/permissions';
import { NotFoundError, type TenantContext } from '@/server/auth/with-tenant';
import {
  deleteSavedFilter,
  getCustomer360,
  getDashboard,
  listReceivableCustomers,
  listSavedFilters,
  saveFilter,
} from '@/server/receivables/service';
import { ensureFixtures, FX } from './fixtures';
import { appPool, closePools, inTenant, inTenantCommit, migratePool } from './helpers';

// Golden (never delete or skip) — task 2.3: overdue = end of the due day in the COMPANY's time
// zone; aging buckets from configuration; DSO definition (docs/metrics.md); totals in the
// reporting currency through reference rates, a missing rate is counted, never guessed; every
// read scoped through the customer (OWN sees only own customers, another customer by id = 404);
// saved filters private to their user.

const KIRI = {
  entity: '1a000000-0000-4000-8000-0000000000e1',
  company: '2a000000-0000-4000-8000-0000000000e1',
};
const PAGO = {
  entity: '1a000000-0000-4000-8000-0000000000e2',
  company: '2a000000-0000-4000-8000-0000000000e2',
};

beforeAll(async () => {
  await ensureFixtures();
  await inTenantCommit(migratePool, null, async (c) => {
    for (const [z, tz] of [
      [KIRI, 'Pacific/Kiritimati'],
      [PAGO, 'Pacific/Pago_Pago'],
    ] as const) {
      await c.query(
        `INSERT INTO legal_entities (id, country_code, tax_id, legal_name, normalized_name, timezone)
         VALUES ($1, 'XX', $2, $2, lower($2), $3) ON CONFLICT (id) DO NOTHING`,
        [z.entity, `GOLDEN-TZ-${tz}`, tz],
      );
    }
    // Test currency XTS (ISO 4217 "for testing"): 1 EUR = 2 XTS.
    await c.query(
      `INSERT INTO exchange_rates (source, base_currency, quote_currency, rate, valid_on)
       VALUES ('GOLDEN', 'EUR', 'XTS', 2, '2000-01-01') ON CONFLICT DO NOTHING`,
    );
  });
  await inTenantCommit(migratePool, FX.tenantA, async (c) => {
    await c.query('SELECT provision_receivables_defaults()');
    for (const z of [KIRI, PAGO]) {
      await c.query(
        `INSERT INTO tenant_companies (id, tenant_id, legal_entity_id, display_name, is_default)
         VALUES ($1, $2, $3, 'Golden TZ company', false) ON CONFLICT (id) DO NOTHING`,
        [z.company, FX.tenantA, z.entity],
      );
    }
  });
});
afterAll(closePools);

function ctxFor(db: PoolClient, userId: string, scope: Scope): TenantContext {
  const requestId = randomUUID();
  return {
    db,
    tenantId: FX.tenantA,
    userId,
    authUserId: 'golden',
    requestId,
    requirePermission: async (key) => ({ key, scope }),
    requireAnyPermission: async (keys) => ({ key: keys[0] ?? '', scope }),
    audit: (entry) => writeAudit(db, { type: 'user', id: userId }, entry, requestId),
  };
}

async function source(db: PoolClient): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM data_sources WHERE name = 'file-import'`,
  );
  return rows[0]?.id ?? '';
}

async function newCustomer(db: PoolClient, owner: string | null): Promise<string> {
  const le = await db.query<{ id: string }>(
    `SELECT find_or_create_legal_entity('XX', $1, 'Golden reads', 'UTC', NULL) AS id`,
    [`READS-${randomUUID().slice(0, 12)}`],
  );
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO customers (tenant_id, legal_entity_id, display_name, owner_user_id)
     VALUES ($1, $2, 'Golden reads customer', $3) RETURNING id`,
    [FX.tenantA, le.rows[0]?.id, owner],
  );
  return rows[0]?.id ?? '';
}

/** Invoice due `dueSql` (SQL date expression), issued 30 days before. */
async function addInvoice(
  db: PoolClient,
  o: {
    customer: string;
    company?: string;
    dueSql: string;
    total: string;
    currency?: string;
    issueSql?: string;
  },
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO invoices (tenant_id, company_id, customer_id, source_id, external_id, number,
                           issue_date, due_date, currency, amount_total, amount_open)
     VALUES ($1, $2, $3, $4, $5, $5, ${o.issueSql ?? `(${o.dueSql}) - 30`}, ${o.dueSql}, $6, $7, $7)
     RETURNING id`,
    [
      FX.tenantA,
      o.company ?? FX.companyA,
      o.customer,
      await source(db),
      randomUUID(),
      o.currency ?? 'EUR',
      o.total,
    ],
  );
  return rows[0]?.id ?? '';
}

const utcToday = `(now() AT TIME ZONE 'UTC')::date`;

describe('golden/db: overdue is the end of the due day in the company time zone', () => {
  it('the same due date is overdue for a company at UTC+14 and not for one at UTC−11', async () => {
    const rows = await inTenant(appPool, FX.tenantA, async (db) => {
      const customer = await newCustomer(db, null);
      const due = `(now() AT TIME ZONE 'Pacific/Kiritimati')::date - 1`;
      const kiri = await addInvoice(db, {
        customer,
        company: KIRI.company,
        dueSql: due,
        total: '10.00',
      });
      const pago = await addInvoice(db, {
        customer,
        company: PAGO.company,
        dueSql: due,
        total: '10.00',
      });
      const res = await db.query<{
        invoice_id: string;
        is_overdue: boolean;
        days_overdue: number;
        aging_bucket: string;
      }>(
        'SELECT invoice_id, is_overdue, days_overdue, aging_bucket FROM invoice_positions WHERE invoice_id = ANY($1)',
        [[kiri, pago]],
      );
      return Object.fromEntries(res.rows.map((r) => [r.invoice_id === kiri ? 'kiri' : 'pago', r]));
    });
    expect(rows.kiri).toMatchObject({ is_overdue: true, days_overdue: 1, aging_bucket: 'd1_30' });
    expect(rows.pago).toMatchObject({
      is_overdue: false,
      days_overdue: 0,
      aging_bucket: 'current',
    });
  });

  it('due today is not overdue yet', async () => {
    const row = await inTenant(appPool, FX.tenantA, async (db) => {
      const customer = await newCustomer(db, null);
      const id = await addInvoice(db, { customer, dueSql: utcToday, total: '5.00' });
      const res = await db.query(
        'SELECT is_overdue, aging_bucket FROM invoice_positions WHERE invoice_id = $1',
        [id],
      );
      return res.rows[0];
    });
    expect(row).toEqual({ is_overdue: false, aging_bucket: 'current' });
  });
});

describe('golden/db: dashboard figures (docs/metrics.md)', () => {
  it('overdue total, aging, DSO, reporting currency and missing FX', async () => {
    const d = await inTenant(appPool, FX.tenantA, async (db) => {
      // Isolate from other rows of tenant A: only this transaction's invoices exist.
      const customer = await newCustomer(db, null);
      await addInvoice(db, { customer, dueSql: `${utcToday} - 45`, total: '100.00' }); // d31_60
      await addInvoice(db, { customer, dueSql: `${utcToday} - 200`, total: '50.00' }); // d181_plus
      await addInvoice(db, {
        customer,
        dueSql: `${utcToday} + 10`,
        total: '600.00',
        issueSql: `${utcToday} - 10`,
      }); // current
      await addInvoice(db, {
        customer,
        dueSql: `${utcToday} - 5`,
        total: '40.00',
        currency: 'XTS',
      }); // 20 EUR, d1_30
      await addInvoice(db, { customer, dueSql: `${utcToday} - 5`, total: '7.00', currency: 'XXX' }); // no rate
      return getDashboard(ctxFor(db, FX.userA, 'ORGANIZATION'));
    });
    expect(d.currency).toBe('EUR');
    expect(d.openTotal).toBe('770.00');
    expect(d.overdueTotal).toBe('170.00');
    expect(d.missingFx).toBe(1);
    expect(Object.fromEntries(d.aging.map((a) => [a.bucket, a.amount]))).toEqual({
      current: '600.00',
      d1_30: '20.00',
      d31_60: '100.00',
      d61_90: '0.00',
      d91_180: '0.00',
      d181_plus: '50.00',
    });
    // Billed in the last 90 days: 600 (issued today−10) + 100 (issued today−75) + 20 + nothing
    // older; DSO = 770 / ((600 + 100 + 20) / 90) = 96.3
    expect(d.dso).toBe('96.3');
  });
});

describe('golden/db: receivables reads are scoped through the customer', () => {
  it('OWN sees only own customers in the list, the dashboard and Customer 360', async () => {
    const out = await inTenant(appPool, FX.tenantA, async (db) => {
      const mine = await newCustomer(db, FX.userA2);
      const other = await newCustomer(db, FX.userA);
      await addInvoice(db, { customer: mine, dueSql: `${utcToday} - 3`, total: '11.00' });
      await addInvoice(db, { customer: other, dueSql: `${utcToday} - 3`, total: '999.00' });
      const ctx = ctxFor(db, FX.userA2, 'OWN');
      const list = await listReceivableCustomers(ctx, {});
      const dash = await getDashboard(ctx);
      const idor = await getCustomer360(ctx, other).catch((e: unknown) => e);
      return { ids: list.map((c) => c.id), mine, overdue: dash.overdueTotal, idor };
    });
    expect(out.ids).toEqual([out.mine]);
    expect(out.overdue).toBe('11.00');
    expect(out.idor).toBeInstanceOf(NotFoundError);
  });

  it('search matches name, tax id and external id; overdue filter keeps only overdue customers', async () => {
    const out = await inTenant(appPool, FX.tenantA, async (db) => {
      const a = await newCustomer(db, null);
      const b = await newCustomer(db, null);
      await db.query(
        `UPDATE customers SET external_id = 'GOLD-EXT-77', display_name = 'Zlatna Reka' WHERE id = $1`,
        [a],
      );
      await addInvoice(db, { customer: a, dueSql: `${utcToday} - 3`, total: '1.00' });
      await addInvoice(db, { customer: b, dueSql: `${utcToday} + 3`, total: '1.00' });
      const ctx = ctxFor(db, FX.userA, 'ORGANIZATION');
      return {
        byExt: (await listReceivableCustomers(ctx, { q: 'gold-ext' })).map((c) => c.id),
        byName: (await listReceivableCustomers(ctx, { q: 'zlatna' })).map((c) => c.id),
        wildcard: (await listReceivableCustomers(ctx, { q: '%' })).length,
        overdue: (await listReceivableCustomers(ctx, { overdue: '1' })).map((c) => c.id),
        a,
        b,
      };
    });
    expect(out.byExt).toEqual([out.a]);
    expect(out.byName).toEqual([out.a]);
    expect(out.wildcard).toBe(0);
    expect(out.overdue).toContain(out.a);
    expect(out.overdue).not.toContain(out.b);
  });

  it('saved filters are private to their user', async () => {
    const out = await inTenant(appPool, FX.tenantA, async (db) => {
      const { id } = await saveFilter(ctxFor(db, FX.userA, 'ORGANIZATION'), {
        name: 'Dospeli',
        filter: { overdue: '1' },
      });
      const other = ctxFor(db, FX.userA2, 'ORGANIZATION');
      return {
        own: (await listSavedFilters(ctxFor(db, FX.userA, 'ORGANIZATION'))).map((f) => f.name),
        theirs: await listSavedFilters(other),
        del: await deleteSavedFilter(other, id).catch((e: unknown) => e),
      };
    });
    expect(out.own).toEqual(['Dospeli']);
    expect(out.theirs).toEqual([]);
    expect(out.del).toBeInstanceOf(NotFoundError);
  });
});
