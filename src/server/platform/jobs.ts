import type { Pool } from 'pg';
import { logEvent } from '@/lib/log';
import { withTenantJob } from '@/server/jobs/tenant-job';

/**
 * Platform job (6.4), daily in the worker:
 *   - trials ending in 3 days → "trial ends" attention item for every operator with
 *     platform.manage (once per trial — platform_trials_to_remind marks it);
 *   - expired sandboxes past their read-only week → deleted (the ONLY tenant DELETE, migration
 *     030), each one audited under tenant #0.
 */
export async function platformDaily(workerPool: Pool, appPool: Pool, jobId: string): Promise<void> {
  const { rows } = await workerPool.query<{ op: string | null }>(
    'SELECT platform_operator_id() AS op',
  );
  const op = rows[0]?.op;
  if (!op) return;

  const reminded = await withTenantJob(appPool, op, jobId, async (job) => {
    const { rows: trials } = await job.db.query<{ id: string }>(
      'SELECT id FROM platform_trials_to_remind()',
    );
    for (const t of trials) {
      await job.db.query(
        `INSERT INTO notifications (tenant_id, user_id, message_key)
         SELECT app_tenant_id(), ur.user_id, 'trial_ending' FROM user_roles ur
         JOIN role_permissions rp ON rp.role_id = ur.role_id JOIN permissions pm ON pm.id = rp.permission_id
         WHERE pm.key = 'platform.manage' GROUP BY ur.user_id`,
      );
      await job.audit({ action: 'platform.trial_reminder', entityType: 'tenants', entityId: t.id });
    }
    return trials.length;
  });

  const { rows: sandboxes } = await workerPool.query<{ id: string }>(
    'SELECT platform_purgeable_sandboxes() AS id',
  );
  let purged = 0;
  for (const s of sandboxes) {
    try {
      const { rows: n } = await workerPool.query<{ n: number }>(
        'SELECT platform_purge_sandbox($1) AS n',
        [s.id],
      );
      await withTenantJob(appPool, op, jobId, (job) =>
        job.audit({
          action: 'platform.sandbox_purged',
          entityType: 'tenants',
          entityId: s.id,
          after: { rows: n[0]?.n ?? 0 },
        }),
      );
      purged += 1;
    } catch (error) {
      logEvent('platform.sandbox_purge_failed', {
        level: 'error',
        tenantId: s.id,
        name: error instanceof Error ? error.name : 'unknown',
      });
    }
  }
  logEvent('platform.daily', { reminded, purged });
}
