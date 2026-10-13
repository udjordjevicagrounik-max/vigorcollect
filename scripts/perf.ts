/**
 * Performance check (task 6.5): 1.000 customers / 20.000 invoices in the TEST database, then the
 * screens people open all day — home dashboard, customer and invoice lists, the six system
 * reports, search, Customer 360, today's work — must answer in < 1 s (server time).
 *
 *   source scripts/lib/env.sh && npx tsx scripts/perf.ts seed      # once (≈ 1–2 min)
 *   source scripts/lib/env.sh && npx tsx scripts/perf.ts measure   # median of 3, exit 1 if > 1 s
 *
 * Only collect_test (refuses any database whose name does not end in "_test"). The data is
 * generated (rule 24): PERF- tax ids, "Perf Kupac" names, the normal import path (applyImport),
 * so the same invoice positions, aging and events exist as after a real import. Prints timings
 * and counts only — never a key, never a URL.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool, type PoolClient } from 'pg';
import { writeAudit } from '../src/server/auth/audit';
import { createTenantContext, type TenantContext } from '../src/server/auth/with-tenant';
import { getMasterKeyring } from '../src/server/crypto/keyring';
import {
  clearDashboardCache,
  dashboardData,
  homeDashboardId,
} from '../src/server/dashboards/service';
import { sealGrid } from '../src/server/imports/crypto';
import { applyImport } from '../src/server/imports/process';
import { grantsByRole, parsePermissionMatrix } from '../src/server/permissions/matrix';
import {
  customerListQuery,
  getCustomer360,
  getDashboard,
  invoiceListQuery,
  listOpenInvoices,
  listReceivableCustomers,
  myWorkToday,
} from '../src/server/receivables/service';
import { listReportDefinitions, runSpec } from '../src/server/reporting/service';
import { listAttention } from '../src/server/attention/service';
import { globalSearch } from '../src/server/search/service';

const PERF = {
  tenant: '0f0f0000-0000-4000-8000-00000000f0f0',
  user: '3f0f0000-0000-4000-8000-00000000f0f0',
  entity: '1f0f0000-0000-4000-8000-00000000f0f0',
  company: '2f0f0000-0000-4000-8000-00000000f0f0',
} as const;
const CUSTOMERS = 1_000;
const PER_CUSTOMER = 20;
const LIMIT_MS = 1_000;

const say = (line: string) => process.stdout.write(`${line}\n`);

function pools() {
  const app = process.env.TEST_DATABASE_URL;
  const migrate = process.env.TEST_MIGRATE_DATABASE_URL;
  if (!app || !migrate) throw new Error('TEST_DATABASE_URL / TEST_MIGRATE_DATABASE_URL missing');
  return {
    app: new Pool({ connectionString: app }),
    migrate: new Pool({ connectionString: migrate }),
  };
}

async function assertTestDb(pool: Pool) {
  const { rows } = await pool.query<{ db: string }>('SELECT current_database() AS db');
  if (!rows[0]?.db.endsWith('_test')) throw new Error('perf runs only on a *_test database');
}

async function tx<T>(
  pool: Pool,
  tenant: string | null,
  fn: (c: PoolClient) => Promise<T>,
  commit = true,
) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    if (tenant) await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
    const out = await fn(c);
    await c.query(commit ? 'COMMIT' : 'ROLLBACK');
    return out;
  } catch (error) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    c.release();
  }
}

/** Deterministic generator (no Math.random: the same data on every machine). */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const dmy = (d: Date) =>
  `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${d.getUTCFullYear()}`;
/** Minor units → "1234,56" (strings only: amounts never go through float, rule 6). */
const amount = (minor: bigint) => `${minor / 100n},${String(minor % 100n).padStart(2, '0')}`;

function grid(today: Date): string[][] {
  const r = rng(6_5);
  const rows: string[][] = [
    [
      'ID',
      'Broj fakture',
      'Datum fakture',
      'Datum dospeća',
      'Oznaka valute',
      'Iznos',
      'Saldo',
      'PIB',
      'Naziv kupca',
      'Fizičko lice',
    ],
  ];
  for (let c = 1; c <= CUSTOMERS; c += 1) {
    for (let i = 1; i <= PER_CUSTOMER; i += 1) {
      const n = (c - 1) * PER_CUSTOMER + i;
      const pastDue = Math.floor(r() * 430) - 60; // -60 … 370 days
      const due = new Date(today.getTime() - pastDue * 86_400_000);
      const issue = new Date(due.getTime() - 30 * 86_400_000);
      const total = BigInt(Math.floor(r() * 2_000_000) + 5_000); // 50,00 … 20.050,00
      const open = r() < 0.25 ? total / 2n : total;
      rows.push([
        `PERF-INV-${n}`,
        `P-${String(n).padStart(6, '0')}`,
        dmy(issue),
        dmy(due),
        c % 10 === 0 ? 'EUR' : 'RSD',
        amount(total),
        amount(open),
        `PERF-${String(c).padStart(9, '0')}`,
        `Perf Kupac ${String(c).padStart(4, '0')} d.o.o.`,
        'ne',
      ]);
    }
  }
  return rows;
}

async function seed() {
  const { app, migrate } = pools();
  await assertTestDb(app);
  const exists = await tx(migrate, PERF.tenant, (c) =>
    c.query<{ n: number }>('SELECT count(*)::int AS n FROM invoices'),
  );
  if ((exists.rows[0]?.n ?? 0) >= CUSTOMERS * PER_CUSTOMER) {
    say(`perf tenant already has ${exists.rows[0]?.n} invoices — nothing to do`);
    await Promise.all([app.end(), migrate.end()]);
    return;
  }
  const grants = grantsByRole(parsePermissionMatrix(readFileSync('docs/permissions.md', 'utf8')));
  await tx(migrate, null, (c) =>
    c.query(
      `INSERT INTO legal_entities (id, country_code, tax_id, legal_name, normalized_name, timezone)
       VALUES ($1, 'RS', 'PERF-COMPANY', 'Perf Company', 'perf company', 'Europe/Belgrade') ON CONFLICT (id) DO NOTHING`,
      [PERF.entity],
    ),
  );
  await tx(migrate, PERF.tenant, async (c) => {
    await c.query(
      // status 'suspended': the worker's tenant clock never runs a daily job over the perf data.
      `INSERT INTO tenants (id, slug, display_name, is_demo, status)
       VALUES ($1, 'perf', 'Perf 1000/20000', true, 'suspended')
       ON CONFLICT (id) DO NOTHING`,
      [PERF.tenant],
    );
    await c.query(
      `INSERT INTO tenant_settings (tenant_id, timezone, default_currency, country_code)
       VALUES ($1, 'Europe/Belgrade', 'RSD', 'RS') ON CONFLICT (tenant_id) DO NOTHING`,
      [PERF.tenant],
    );
    await c.query(
      `INSERT INTO tenant_companies (id, tenant_id, legal_entity_id, display_name, is_default)
       VALUES ($1, $2, $3, 'Perf Company', true) ON CONFLICT DO NOTHING`,
      [PERF.company, PERF.tenant, PERF.entity],
    );
    await c.query(
      `INSERT INTO users (id, tenant_id, email, display_name, timezone, status)
       VALUES ($1, $2, 'owner@perf.example.test', 'Perf Owner', 'Europe/Belgrade', 'active') ON CONFLICT (id) DO NOTHING`,
      [PERF.user, PERF.tenant],
    );
    for (const [role, keys] of grants) {
      await c.query(
        `INSERT INTO roles (tenant_id, key, is_system) VALUES ($1, $2, true) ON CONFLICT (tenant_id, key) DO NOTHING`,
        [PERF.tenant, role],
      );
      await c.query(
        `INSERT INTO role_permissions (tenant_id, role_id, permission_id)
         SELECT $1, r.id, p.id FROM roles r JOIN permissions p ON p.key = ANY($3::text[])
         WHERE r.key = $2 AND p.key <> 'platform.manage' ON CONFLICT DO NOTHING`,
        [PERF.tenant, role, keys],
      );
    }
    await c.query(
      `INSERT INTO user_roles (tenant_id, user_id, role_id, scope)
       SELECT $1, $2, id, 'ORGANIZATION' FROM roles WHERE key = 'owner' ON CONFLICT DO NOTHING`,
      [PERF.tenant, PERF.user],
    );
    await c.query('SELECT provision_receivables_defaults()');
  });

  const keyring = getMasterKeyring();
  const data = grid(new Date());
  const started = Date.now();
  await tx(app, PERF.tenant, async (c) => {
    const src = await c.query<{ id: string }>(
      `SELECT id FROM data_sources WHERE name = 'file-import'`,
    );
    const id = randomUUID();
    const sealed = sealGrid(keyring, PERF.tenant, id, data);
    const mapping = {
      columns: {
        external_id: 0,
        number: 1,
        issue_date: 2,
        due_date: 3,
        currency: 4,
        amount_total: 5,
        amount_open: 6,
        customer_tax_id: 7,
        customer_name: 8,
        customer_is_natural_person: 9,
      },
      decimal: 'comma',
      dateOrder: 'dmy',
    };
    await c.query(
      `INSERT INTO import_runs (id, tenant_id, source_id, company_id, file_format, file_sha256, payload_enc,
                                payload_key_version, mapping, rows_total, status, confirmed_at, confirmed_by, created_by)
       VALUES ($1, app_tenant_id(), $2, $3, 'csv', digest($4, 'sha256'), $5, $6, $7, $8, 'confirmed', now(), $9, $9)`,
      [
        id,
        src.rows[0]?.id,
        PERF.company,
        'perf',
        sealed.ciphertext,
        sealed.keyVersion,
        mapping,
        data.length - 1,
        PERF.user,
      ],
    );
    await applyImport(
      c,
      (e) => writeAudit(c, { type: 'system', id: null }, e, null),
      keyring,
      PERF.tenant,
      id,
    );
  });
  say(
    `seeded ${CUSTOMERS} customers / ${CUSTOMERS * PER_CUSTOMER} invoices in ${Math.round((Date.now() - started) / 1000)} s`,
  );
  // Nobody consumes the perf tenant's events (invoice.created × 20.000): closed here so they never
  // flood the worker that e2e and golden tests share on this database.
  await tx(migrate, PERF.tenant, (c) =>
    c.query(
      `WITH p AS (UPDATE domain_events SET status = 'processing' WHERE status = 'pending' RETURNING id)
       SELECT count(*) FROM p`,
    ),
  );
  await tx(migrate, PERF.tenant, (c) =>
    c.query(
      `UPDATE domain_events SET status = 'processed', processed_at = now() WHERE status = 'processing'`,
    ),
  );
  await tx(migrate, null, (c) => c.query('ANALYZE'));
  await Promise.all([app.end(), migrate.end()]);
}

async function timed(label: string, app: Pool, fn: (ctx: TenantContext) => Promise<unknown>) {
  const times: number[] = [];
  let size = 0;
  for (let i = 0; i < 3; i += 1) {
    clearDashboardCache();
    const t = await tx(
      app,
      PERF.tenant,
      async (c) => {
        const ctx = createTenantContext(c, {
          tenantId: PERF.tenant,
          userId: PERF.user,
          authUserId: 'perf',
          requestId: randomUUID(),
        });
        const start = performance.now();
        const out = await fn(ctx);
        const ms = performance.now() - start;
        size = Array.isArray(out) ? out.length : size;
        return ms;
      },
      false,
    );
    times.push(t);
  }
  const median = times.sort((a, b) => a - b)[1] ?? 0;
  const ok = median < LIMIT_MS;
  say(
    `${ok ? 'ok  ' : 'SLOW'} ${String(Math.round(median)).padStart(5)} ms  ${label}${size ? ` (${size} rows)` : ''}`,
  );
  return ok;
}

async function measure() {
  const { app, migrate } = pools();
  await assertTestDb(app);
  await migrate.end();
  const results: boolean[] = [];
  const customer = await tx(app, PERF.tenant, (c) =>
    c.query<{ id: string }>(`SELECT id FROM customers ORDER BY id LIMIT 1 OFFSET 500`),
  );
  const customerId = customer.rows[0]?.id ?? '';
  results.push(
    await timed('home dashboard (cold, all widgets)', app, async (ctx) =>
      dashboardData(ctx, await homeDashboardId(ctx), 'sr-Latn', { refresh: true }),
    ),
  );
  results.push(await timed('  └ KPI + aging (one pass)', app, (ctx) => getDashboard(ctx)));
  results.push(await timed('  └ needs attention', app, (ctx) => listAttention(ctx)));
  results.push(
    await timed('customers list', app, (ctx) =>
      listReceivableCustomers(ctx, customerListQuery.parse({})),
    ),
  );
  results.push(
    await timed('customers list, overdue only', app, (ctx) =>
      listReceivableCustomers(ctx, customerListQuery.parse({ overdue: '1' })),
    ),
  );
  results.push(
    await timed('invoices list', app, (ctx) => listOpenInvoices(ctx, invoiceListQuery.parse({}))),
  );
  results.push(
    await timed('invoices list, overdue only', app, (ctx) =>
      listOpenInvoices(ctx, invoiceListQuery.parse({ overdue: '1' })),
    ),
  );
  results.push(
    await timed('invoices list, bucket 61-90', app, (ctx) =>
      listOpenInvoices(ctx, invoiceListQuery.parse({ bucket: 'd61_90' })),
    ),
  );
  results.push(
    await timed('search "Kupac 05"', app, (ctx) => globalSearch(ctx, { q: 'Kupac 05' })),
  );
  results.push(await timed('Customer 360', app, (ctx) => getCustomer360(ctx, customerId)));
  results.push(await timed("today's work (team)", app, (ctx) => myWorkToday(ctx, 'team')));
  const defs = await tx(
    app,
    PERF.tenant,
    (c) =>
      listReportDefinitions(
        createTenantContext(c, {
          tenantId: PERF.tenant,
          userId: PERF.user,
          authUserId: 'perf',
          requestId: randomUUID(),
        }),
      ),
    false,
  );
  for (const d of defs.filter((x) => x.isSystem))
    results.push(
      await timed(`report: ${d.systemKey ?? d.name}`, app, (ctx) => runSpec(ctx, d.definition)),
    );
  await app.end();
  const slow = results.filter((x) => !x).length;
  say(
    slow ? `${slow} screen(s) over ${LIMIT_MS} ms` : `all ${results.length} under ${LIMIT_MS} ms`,
  );
  if (slow) process.exit(1);
}

const command = process.argv[2];
if (command === 'seed') await seed();
else if (command === 'measure') await measure();
else {
  process.stderr.write('usage: npx tsx scripts/perf.ts seed|measure\n');
  process.exit(2);
}
