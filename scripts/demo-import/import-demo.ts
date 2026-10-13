/**
 * Imports scripts/demo-import/fakture-demo.csv into the DEMO tenant of the DEV database through the
 * import service (upload → validation → confirm), as the demo admin — never with hand-written SQL
 * (task 2.5). The confirmed run is applied by the job worker (event import.confirmed), exactly as
 * in production; this script waits for it and prints counts only (no data, no secrets).
 *
 *   npx tsx scripts/demo-import/import-demo.ts            # import + counts
 *   npx tsx scripts/demo-import/import-demo.ts --report   # counts of the last run only
 */
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { createTenantContext } from '../../src/server/auth/with-tenant';
import { confirmImport, uploadImport, validateImport } from '../../src/server/imports/service';

const DEMO = {
  tenantId: 'd0000000-0000-4000-8000-000000000001',
  userId: 'd0000000-0000-4000-8000-000000000a01',
} as const;
const FILE = 'scripts/demo-import/fakture-demo.csv';

async function inDemo<T>(
  client: Client,
  fn: (ctx: ReturnType<typeof createTenantContext>) => Promise<T>,
): Promise<T> {
  await client.query('BEGIN');
  try {
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [DEMO.tenantId]);
    const ctx = createTenantContext(client as never, {
      tenantId: DEMO.tenantId,
      userId: DEMO.userId,
      authUserId: 'script:demo-import',
      requestId: crypto.randomUUID(),
    });
    const result = await fn(ctx);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

async function main(): Promise<void> {
  process.loadEnvFile('.env');
  const url = process.env.DATABASE_URL;
  if (!url || /_test(\?|$)/.test(new URL(url).pathname))
    throw new Error('DATABASE_URL (dev, vigor_app) is required.');
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const reportOnly = process.argv.includes('--report');
    const runId = reportOnly
      ? await inDemo(client, async (ctx) => {
          const last = await ctx.db.query<{ id: string }>(
            'SELECT id FROM import_runs ORDER BY created_at DESC LIMIT 1',
          );
          return last.rows[0]?.id ?? '';
        })
      : await inDemo(client, async (ctx) => {
          const content = readFileSync(FILE).toString('base64');
          const up = await uploadImport(ctx, {
            fileName: 'fakture-demo.csv',
            format: 'csv',
            content,
          });
          const preview = await validateImport(ctx, up.id, { mapping: up.mapping });
          console.warn(`validated: ${preview.rowsValid} valid, ${preview.rowsInvalid} invalid`);
          await confirmImport(ctx, up.id);
          return up.id;
        });
    // The worker picks the event up within seconds (outbox poll).
    let status = reportOnly ? 'skip' : 'confirmed';
    for (let i = 0; i < 60 && status === 'confirmed'; i += 1) {
      await new Promise((r) => setTimeout(r, 2000));
      status = await inDemo(client, async (ctx) => {
        const res = await ctx.db.query<{ status: string }>(
          'SELECT status FROM import_runs WHERE id = $1',
          [runId],
        );
        return res.rows[0]?.status ?? 'missing';
      });
    }
    const counts = await inDemo(client, async (ctx) => {
      const run = await ctx.db.query<{
        invoices_created: number;
        invoices_updated: number;
        customers_created: number;
        exceptions_count: number;
      }>(
        'SELECT invoices_created, invoices_updated, customers_created, exceptions_count FROM import_runs WHERE id = $1',
        [runId],
      );
      const totals = await ctx.db.query<{ invoices: number; customers: number }>(
        `SELECT (SELECT count(*) FROM invoices)::int AS invoices,
                (SELECT count(DISTINCT customer_id) FROM invoices)::int AS customers`,
      );
      // Same definitions as the dashboard (docs/metrics.md), read from invoice_positions.
      const money = await ctx.db.query<{
        overdue: string | null;
        open: string | null;
        missing: number;
        currency: string;
      }>(
        `SELECT sum(open_reporting) FILTER (WHERE is_overdue) AS overdue, sum(open_reporting) FILTER (WHERE is_open) AS open,
                count(*) FILTER (WHERE is_open AND open_reporting IS NULL)::int AS missing,
                (SELECT default_currency FROM tenant_settings) AS currency
         FROM invoice_positions`,
      );
      return { run: run.rows[0], totals: totals.rows[0], money: money.rows[0] };
    });
    if (!reportOnly) console.warn(`run status: ${status}`);
    console.warn(`run: ${JSON.stringify(counts.run)}`);
    console.warn(
      `tenant: ${counts.totals?.invoices} invoices, ${counts.totals?.customers} customers with invoices`,
    );
    console.warn(
      `overdue total: ${counts.money?.overdue ?? '0.00'} ${counts.money?.currency ?? ''}; open total: ${counts.money?.open ?? '0.00'}; missing FX: ${counts.money?.missing ?? 0}`,
    );
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
