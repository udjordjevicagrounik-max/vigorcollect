import { PgBoss } from 'pg-boss';
import { Pool, type PoolClient } from 'pg';
import { logEvent } from '@/lib/log';
import { getMasterKeyring } from '@/server/crypto/keyring';
import { fxRatesJob } from '@/server/fx/rates-job';
import { dispatchDue } from '@/server/integrations/outbound';
import { dispatchIntegrationMail } from '@/server/mail/dispatch-integration';
import { DAILY_QUEUE, runTenantDaily, tenantClockTick, type DailyJob } from './clock';
import { EVENT_HANDLERS } from './handlers';
import { dispatchMail } from './mail-dispatch';
import { alertsCheck, runOpsScript } from './ops';
import {
  dispatchPending,
  EVENT_QUEUE,
  EVENT_RETRY_LIMIT,
  processEvent,
  type EventHandlers,
} from './outbox';
import { runRetention } from './retention';
import { withTenantJob } from './tenant-job';

/**
 * The worker process (task 1.3): same image as the app, PROCESS_ROLE=worker (src/instrumentation.ts).
 *   - WORKER_DATABASE_URL (vigor_worker): pg-boss + outbox/mail status + tenant_clock();
 *   - DATABASE_URL (vigor_app): every piece of tenant work, inside withTenantJob().
 */

const RETRY = { retryLimit: EVENT_RETRY_LIMIT, retryBackoff: true, retryDelay: 5 } as const;
const OUTBOX_POLL_MS = 5_000;

export type Worker = { boss: PgBoss; stop(): Promise<void> };

function txDb(client: PoolClient) {
  return { executeSql: (text: string, values?: unknown[]) => client.query(text, values) };
}

export async function startWorker(
  env: { workerUrl: string; appUrl: string },
  handlers: EventHandlers = EVENT_HANDLERS,
): Promise<Worker> {
  const workerPool = new Pool({ connectionString: env.workerUrl, max: 4 });
  const appPool = new Pool({ connectionString: env.appUrl, max: 4 });
  // The schema exists (migration 007); vigor_worker may create tables in it, not schemas.
  const boss = new PgBoss({
    connectionString: env.workerUrl,
    schema: 'pgboss',
    createSchema: false,
  });
  boss.on('error', (error: Error) =>
    logEvent('worker.error', { level: 'error', name: error.name }),
  );
  await boss.start();
  // /health reads aggregates through job_health() (owned by vigor_migrate).
  await workerPool
    .query('GRANT SELECT ON pgboss.job TO vigor_migrate')
    .catch(() => logEvent('worker.health_grant_failed', { level: 'warn' }));

  for (const name of [EVENT_QUEUE, DAILY_QUEUE, 'retention']) await boss.createQueue(name, RETRY);
  for (const name of [
    'tenant-clock',
    'mail-dispatch',
    'integrations-dispatch',
    'backup',
    'restore-test',
    'alerts-check',
    'fx-rates',
  ]) {
    await boss.createQueue(name);
  }

  await boss.work<{ eventId: string }, unknown, { includeMetadata: true }>(
    EVENT_QUEUE,
    { includeMetadata: true },
    async (jobs) => {
      for (const job of jobs) {
        await processEvent({ workerPool, appPool, handlers }, job.data.eventId, {
          retryCount: job.retryCount,
          retryLimit: job.retryLimit,
        });
      }
    },
  );
  await boss.work<DailyJob>(DAILY_QUEUE, async (jobs) => {
    for (const job of jobs) await runTenantDaily(appPool, job.data, job.id);
  });
  await boss.work('tenant-clock', async () => {
    await tenantClockTick(workerPool, new Date(), async (id, data) =>
      Boolean(await boss.send(DAILY_QUEUE, data, { id, ...RETRY })),
    );
  });
  await boss.work('mail-dispatch', async () => {
    await dispatchMail(workerPool);
  });
  // 4.1/4.2: outbound deliveries (and integration mail) per tenant, inside withTenantJob.
  await boss.work('integrations-dispatch', async (jobs) => {
    await dispatchIntegrations(workerPool, appPool, jobs[0]?.id ?? 'integrations-dispatch');
  });
  await boss.work('retention', async () => runRetention({ workerPool, appPool }));
  // Ops (task 1.7): scripts need pg_dump + superuser credentials; without them they log why.
  await boss.work('backup', async () => {
    await runOpsScript('backup');
  });
  await boss.work('restore-test', async () => {
    await runOpsScript('restore-test');
  });
  await boss.work('alerts-check', async () => {
    await alertsCheck({ workerPool, appPool });
  });
  // Reference rates (rule 18): ECB publishes around 16:00 CET on working days.
  await boss.work('fx-rates', async () => {
    await fxRatesJob({ workerPool, appPool });
  });

  // Schedules in UTC; tenant-local times are resolved by tenant-clock (rule 26).
  await boss.schedule('tenant-clock', '*/15 * * * *');
  await boss.schedule('mail-dispatch', '* * * * *');
  await boss.schedule('integrations-dispatch', '* * * * *');
  await boss.schedule('retention', '30 2 * * *');
  await boss.schedule('backup', '0 2 * * *');
  await boss.schedule('restore-test', '0 3 * * 0');
  await boss.schedule('alerts-check', '*/5 * * * *');
  await boss.schedule('fx-rates', '30 16 * * 1-5');

  const enqueue = (client: PoolClient, event: { id: string; tenantId: string }) =>
    boss
      .send(
        EVENT_QUEUE,
        { eventId: event.id, tenantId: event.tenantId },
        { id: event.id, ...RETRY, db: txDb(client) },
      )
      .then(() => undefined);
  let polling = false;
  const poll = async () => {
    if (polling) return;
    polling = true;
    try {
      await dispatchPending(workerPool, enqueue);
    } catch (error) {
      logEvent('outbox.dispatch_error', {
        level: 'error',
        name: error instanceof Error ? error.name : 'unknown',
      });
    } finally {
      polling = false;
    }
  };
  const timer = setInterval(() => void poll(), OUTBOX_POLL_MS);
  await poll();
  logEvent('worker.started', {});

  return {
    boss,
    async stop() {
      clearInterval(timer);
      await boss.stop({ graceful: true });
      await Promise.all([workerPool.end(), appPool.end()]);
      logEvent('worker.stopped', {});
    },
  };
}

/** Every tenant (tenant_clock(): the worker's only tenant list) — its due outbound work. */
export async function dispatchIntegrations(
  workerPool: Pool,
  appPool: Pool,
  jobId: string,
): Promise<void> {
  const { rows } = await workerPool.query<{ tenant_id: string }>(
    'SELECT DISTINCT tenant_id FROM tenant_clock()',
  );
  for (const r of rows) {
    try {
      await withTenantJob(appPool, r.tenant_id, jobId, async (ctx) => {
        await dispatchDue(ctx.db, getMasterKeyring());
        await dispatchIntegrationMail(ctx.db, getMasterKeyring());
      });
    } catch (error) {
      logEvent('integrations.dispatch_error', {
        level: 'error',
        tenantId: r.tenant_id,
        name: error instanceof Error ? error.name : 'unknown',
      });
    }
  }
}

/** Entry for PROCESS_ROLE=worker. Fails fast without its database URLs (no secret printed). */
export async function runWorkerFromEnv(): Promise<void> {
  const workerUrl = process.env.WORKER_DATABASE_URL;
  const appUrl = process.env.DATABASE_URL;
  if (!workerUrl || !appUrl) throw new Error('WORKER_DATABASE_URL and DATABASE_URL are required.');
  const worker = await startWorker({ workerUrl, appUrl });
  const shutdown = () => void worker.stop().finally(() => process.exit(0));
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
