import { execFile, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { logEvent } from '@/lib/log';
import { evaluateAlerts, initialAlertState, type AlertInputs } from '@/server/alerts/checks';
import { sendAlert } from '@/server/alerts/adapter';
import { healthReport, liveHealthDeps } from '@/server/health';
import { jobHealth } from './health';

/**
 * Ops jobs in the worker (task 1.7): nightly backup 02:00 UTC, weekly restore test Sunday 03:00
 * UTC (scripts/backup.sh, scripts/restore-test.sh — copied to <image>/ops), and the alarm check
 * every 5 minutes. The scripts need pg_dump/pg_restore and superuser credentials
 * (BACKUP_DATABASE_URL). Without them the job logs why and does nothing — the
 * "backup not done by 06:00" alarm makes that visible (it is not silently "ok").
 */

export type OpsScript = 'backup' | 'restore-test';

function scriptsDir(): string {
  const candidates = [
    process.env.OPS_SCRIPTS_DIR,
    join(process.cwd(), 'ops'),
    join(process.cwd(), 'scripts'),
  ];
  return candidates.find((d): d is string => Boolean(d && existsSync(join(d, 'backup.sh')))) ?? '';
}

export function opsAvailability(): { ok: true; dir: string } | { ok: false; reason: string } {
  const dir = scriptsDir();
  if (!dir) return { ok: false, reason: 'scripts_missing' };
  for (const tool of ['pg_dump', 'pg_restore', 'psql']) {
    if (spawnSync(tool, ['--version'], { stdio: 'ignore' }).status !== 0) {
      return { ok: false, reason: `${tool}_missing_in_image` };
    }
  }
  if (!process.env.BACKUP_DATABASE_URL && !process.env.POSTGRES_PASSWORD) {
    return { ok: false, reason: 'no_backup_credentials' };
  }
  return { ok: true, dir };
}

export async function runOpsScript(name: OpsScript): Promise<boolean> {
  const available = opsAvailability();
  if (!available.ok) {
    logEvent(`${name}.unavailable`, { level: 'warn', reason: available.reason });
    return false;
  }
  return new Promise((resolve) => {
    execFile(
      'bash',
      [join(available.dir, `${name}.sh`)],
      { timeout: 60 * 60 * 1000, maxBuffer: 1024 * 1024 },
      (error) => {
        // Only the exit code is logged: the scripts print counts, never data or secrets.
        logEvent(`${name}.finished`, { level: error ? 'error' : 'info', ok: !error });
        resolve(!error);
      },
    );
  });
}

const alertState = initialAlertState();
let consecutiveAppFailures = 0;

/** Collects the alarm inputs (P0 only) and sends what fires. */
export async function alertsCheck(
  deps: { workerPool: Pool; appPool: Pool },
  now = new Date(),
): Promise<string[]> {
  const ops = await deps.appPool.query<{
    kind: string;
    status: 'ok' | 'failed';
    finished_at: Date;
  }>(
    `(SELECT kind, status, finished_at FROM ops_runs WHERE kind = 'backup' AND status = 'ok'
        ORDER BY finished_at DESC LIMIT 1)
     UNION ALL
     (SELECT 'restore_last', status, finished_at FROM ops_runs WHERE kind = 'restore_test'
        ORDER BY finished_at DESC LIMIT 1)
     UNION ALL
     (SELECT 'restore_ok', status, finished_at FROM ops_runs WHERE kind = 'restore_test' AND status = 'ok'
        ORDER BY finished_at DESC LIMIT 1)`,
  );
  const row = (k: string) => ops.rows.find((r) => r.kind === k);
  const tz = await deps.workerPool.query<{ tz: string }>('SELECT platform_timezone() AS tz');
  const health = await healthReport(liveHealthDeps);
  let appOk = true;
  if (process.env.APP_HEALTH_URL) {
    appOk = await fetch(process.env.APP_HEALTH_URL, { signal: AbortSignal.timeout(5_000) })
      .then((r) => r.ok)
      .catch(() => false);
  }
  consecutiveAppFailures = appOk ? 0 : consecutiveAppFailures + 1;
  const restoreLast = row('restore_last');
  const inputs: AlertInputs = {
    now,
    platformTimezone: tz.rows[0]?.tz ?? 'UTC',
    lastBackupOkAt: row('backup')?.finished_at ?? null,
    lastRestoreTest: restoreLast
      ? { status: restoreLast.status, finishedAt: restoreLast.finished_at }
      : null,
    lastRestoreOkAt: row('restore_ok')?.finished_at ?? null,
    jobs: await jobHealth(deps.appPool).catch(() => null),
    healthOk: health.db === 'ok' && appOk,
    healthReason: health.db !== 'ok' ? 'db' : appOk ? 'ok' : 'app',
  };
  const alerts = evaluateAlerts(inputs, alertState);
  for (const alert of alerts) await sendAlert(alert);
  return alerts.map((a) => a.kind);
}
