import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeAudit } from '@/server/auth/audit';
import type { Scope } from '@/server/auth/permissions';
import { InvalidRequestError, type TenantContext } from '@/server/auth/with-tenant';
import {
  drill,
  listReportDefinitions,
  runSpec,
  saveReportDefinition,
} from '@/server/reporting/service';
import { ensureFixtures, FX } from './fixtures';
import { appPool, closePools, inTenant, inTenantCommit, migratePool } from './helpers';

// Golden (never delete or skip) — task 6.2:
//   - a builder query never leaves the member's scope (OWN sees own customers only);
//   - a field outside the white list → 400 (InvalidRequestError), never SQL;
//   - money over several currencies without FX → mixed_currencies; with FX → fx_convert into
//     the tenant's reporting currency;
//   - the six system reports exist per tenant and run; drill-down lists the entities.

beforeAll(async () => {
  await ensureFixtures();
  await inTenantCommit(migratePool, null, async (c) => {
    await c.query(
      `INSERT INTO exchange_rates (source, base_currency, quote_currency, rate, valid_on)
       VALUES ('GOLDEN', 'EUR', 'XTS', 2, '2000-01-01') ON CONFLICT DO NOTHING`,
    );
  });
  await inTenantCommit(migratePool, FX.tenantA, async (c) => {
    await c.query('SELECT provision_receivables_defaults()');
  });
});
afterAll(closePools);

function ctxFor(
  db: PoolClient,
  userId: string = FX.userA,
  scope: Scope = 'ORGANIZATION',
): TenantContext {
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

async function customer(db: PoolClient, name: string, owner: string | null): Promise<string> {
  const le = await db.query<{ id: string }>(
    `SELECT find_or_create_legal_entity('XX', $1, $2, 'UTC', NULL) AS id`,
    [`RB-${randomUUID().slice(0, 12)}`, name],
  );
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO customers (tenant_id, legal_entity_id, display_name, owner_user_id) VALUES ($1, $2, $3, $4) RETURNING id`,
    [FX.tenantA, le.rows[0]?.id, name, owner],
  );
  return rows[0]?.id ?? '';
}

async function invoice(
  db: PoolClient,
  customerId: string,
  total: string,
  currency = 'EUR',
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO invoices (tenant_id, company_id, customer_id, source_id, external_id, number, issue_date, due_date,
                           currency, amount_total, amount_open)
     SELECT $1, $2, $3, s.id, $4, $4, current_date - 40, current_date - 10, $5, $6, $6
     FROM data_sources s WHERE s.name = 'file-import' RETURNING id`,
    [FX.tenantA, FX.companyA, customerId, `RB-${randomUUID().slice(0, 8)}`, currency, total],
  );
  return rows[0]?.id ?? '';
}

const byCustomer = (filter: string) => ({
  dataset: 'invoices' as const,
  dimensions: [{ field: 'customer' }],
  measures: [{ field: 'open_amount', agg: 'sum' as const, fx: true }],
  filters: [{ field: 'customer', op: 'contains' as const, value: filter }],
});

describe('golden/db: report builder (6.2)', () => {
  it('never leaves the scope: OWN sees only own customers', async () => {
    const out = await inTenant(appPool, FX.tenantA, async (db) => {
      await invoice(db, await customer(db, 'RB Moj d.o.o.', FX.userA2), '100.00');
      await invoice(db, await customer(db, 'RB Tudji d.o.o.', FX.userA), '200.00');
      const own = await runSpec(ctxFor(db, FX.userA2, 'OWN'), byCustomer('RB '));
      const org = await runSpec(ctxFor(db), byCustomer('RB '));
      return { own: own.rows.map((r) => r.d0), org: org.rows.map((r) => r.d0) };
    });
    expect(out.own).toEqual(['RB Moj d.o.o.']);
    expect(out.org.sort()).toEqual(['RB Moj d.o.o.', 'RB Tudji d.o.o.']);
  });

  it('a field outside the white list is a 400, never SQL', async () => {
    const out = await inTenant(appPool, FX.tenantA, async (db) => {
      const ctx = ctxFor(db);
      return Promise.all([
        runSpec(ctx, {
          dataset: 'invoices',
          dimensions: [{ field: 'amount_open' }],
          measures: [{ field: 'count', agg: 'count' }],
        }).catch((e: unknown) => e),
        runSpec(ctx, {
          dataset: 'invoices',
          dimensions: [{ field: 'pg_sleep' }],
          measures: [{ field: 'count', agg: 'count' }],
        }).catch((e: unknown) => e),
        runSpec(ctx, { dataset: 'invoices', measures: [{ field: 'customer', agg: 'sum' }] }).catch(
          (e: unknown) => e,
        ),
        runSpec(ctx, {
          dataset: 'invoices',
          measures: [{ field: 'count', agg: 'count' }],
          filters: [{ field: 'cf.nepostoji', op: 'eq', value: 'x' }],
        }).catch((e: unknown) => e),
      ]);
    });
    for (const e of out) expect(e).toBeInstanceOf(InvalidRequestError);
  });

  it('several currencies: without FX refused, with FX converted into the reporting currency', async () => {
    const out = await inTenant(appPool, FX.tenantA, async (db) => {
      const c = await customer(db, 'RB Valute d.o.o.', FX.userA);
      await invoice(db, c, '100.00', 'EUR');
      await invoice(db, c, '50.00', 'XTS');
      const ctx = ctxFor(db);
      const spec = (fx: boolean) => ({
        dataset: 'invoices' as const,
        measures: [{ field: 'open_amount', agg: 'sum' as const, fx }],
        filters: [{ field: 'customer', op: 'eq' as const, value: 'RB Valute d.o.o.' }],
      });
      const raw = await runSpec(ctx, spec(false)).catch((e: unknown) => e);
      const fx = await runSpec(ctx, spec(true));
      return { raw, fx: fx.rows[0]?.m0, currency: fx.columns[0]?.currency };
    });
    expect(out.raw).toMatchObject({ code: 'mixed_currencies' });
    // 100 EUR + 50 XTS (1 EUR = 2 XTS) = 125.00 EUR
    expect(out.fx).toBe('125.00');
    expect(out.currency).toBe('EUR');
  });

  it('the six system reports exist and run; a saved report is private; drill-down lists entities', async () => {
    const out = await inTenant(appPool, FX.tenantA, async (db) => {
      const ctx = ctxFor(db);
      const c = await customer(db, 'RB Drill d.o.o.', FX.userA);
      await invoice(db, c, '10.00');
      const defs = await listReportDefinitions(ctx);
      const system = defs.filter((d) => d.isSystem);
      for (const d of system) await runSpec(ctx, d.definition);
      const spec = byCustomer('RB Drill');
      const { id } = await saveReportDefinition(ctx, {
        name: 'Moj izveštaj',
        definition: spec,
        visual: 'bar',
      });
      const other = await listReportDefinitions(ctxFor(db, FX.userA2));
      const run = await runSpec(ctx, spec);
      const items = await drill(ctx, { definition: spec, values: { d0: run.rows[0]?.d0 ?? null } });
      const sysUpdate = await db
        .query('UPDATE report_definitions SET name = $1 WHERE id = $2', ['x', system[0]?.id])
        .then(
          () => 'updated',
          (e: { code?: string }) => e.code,
        );
      return {
        keys: system.map((d) => d.systemKey).sort(),
        id,
        otherSees: other.some((d) => d.id === id),
        items: items.items,
        sysUpdate,
      };
    });
    expect(out.keys).toEqual([
      'aging_by_collector',
      'aging_by_customer',
      'cases_by_stage',
      'collected_by_period',
      'disputes',
      'promises',
    ]);
    expect(out.otherSees).toBe(false);
    expect(out.items).toEqual([
      expect.objectContaining({ href: expect.stringMatching(/^\/customers\/.+\?tab=invoices$/) }),
    ]);
    expect(out.sysUpdate).toBe('42501');
  });
});
