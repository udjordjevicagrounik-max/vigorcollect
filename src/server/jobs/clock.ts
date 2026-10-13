import type { Pool } from 'pg';
import { logEvent } from '@/lib/log';
import { runDailyCollections } from '@/server/collections/service';
import { runDailyRisk } from '@/server/risk/service';
import { runDailyWorkflows } from '@/server/workflows/engine';
import { dailyRun, runId } from './schedule';
import { withTenantJob } from './tenant-job';

/**
 * Tenant clock (rule 26). Every tick reads (tenant, time zone) through tenant_clock() — the worker
 * has no access to tenant tables — and enqueues the daily run of every tenant whose local 06:00
 * has passed. The job id is derived from tenant + LOCAL date, so a tenant runs once per local day
 * no matter how many ticks see it due.
 */
export const DAILY_QUEUE = 'tenant-daily';
export const DAILY_LOCAL_TIME = '06:00';

export type DailyJob = { tenantId: string; localDate: string };

export async function tenantClockTick(
  workerPool: Pool,
  now: Date,
  enqueue: (jobId: string, job: DailyJob) => Promise<boolean>,
): Promise<string[]> {
  const { rows } = await workerPool.query<{ tenant_id: string; timezone: string }>(
    'SELECT tenant_id, timezone FROM tenant_clock()',
  );
  const enqueued: string[] = [];
  for (const r of rows) {
    const run = dailyRun(r.timezone, now, DAILY_LOCAL_TIME);
    if (!run.due) continue;
    const id = runId(DAILY_QUEUE, r.tenant_id, run.localDate);
    if (await enqueue(id, { tenantId: r.tenant_id, localDate: run.localDate })) enqueued.push(id);
  }
  return enqueued;
}

/**
 * The daily tenant job (after local 06:00): promise evaluation (fulfilled / partial / broken at
 * D + grace in the company's zone) and invoice.overdue events (task 2.4), then the daily rule
 * triggers (days from due, no activity, specific date — task 3.1), then risk scores (4.3).
 */
export async function runTenantDaily(appPool: Pool, job: DailyJob, jobId: string): Promise<void> {
  await withTenantJob(appPool, job.tenantId, jobId, async (ctx) => {
    const result = await runDailyCollections(ctx.db, ctx.audit);
    const runs = await runDailyWorkflows(ctx.db, ctx.audit);
    // 4.3: risk scores (external providers only where their cache expired).
    const risk = await runDailyRisk(ctx.db, ctx.audit);
    logEvent('tenant.daily', {
      tenantId: job.tenantId,
      localDate: job.localDate,
      riskScored: risk,
      ...result,
      workflowRuns: runs.succeeded + runs.skipped + runs.failed,
      workflowFailed: runs.failed,
    });
  });
}
