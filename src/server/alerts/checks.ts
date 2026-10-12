import { dailyRun } from '@/server/jobs/schedule';
import type { Alert } from './adapter';

/**
 * Alarm rules (task 1.7), pure: inputs → alarms to send. A firing alarm repeats at most once per
 * hour (RENOTIFY_MS); when its condition clears it re-arms.
 *   - backup_missing: after 06:00 local time of tenant #0 there is no successful backup today
 *     (local date);
 *   - events_failed: failed jobs > 0;
 *   - events_stuck: oldest pending job older than 15 min;
 *   - health_red: health failed 2× in a row;
 *   - restore_test_failed: the latest restore test failed.
 */
export const STUCK_LIMIT_SECONDS = 15 * 60;
export const RENOTIFY_MS = 60 * 60 * 1000;

export type AlertInputs = {
  now: Date;
  platformTimezone: string;
  lastBackupOkAt: Date | null;
  lastRestoreTest: { status: 'ok' | 'failed'; finishedAt: Date } | null;
  lastRestoreOkAt: Date | null;
  jobs: { failed: number | null; oldestPendingSeconds: number | null } | null;
  healthOk: boolean;
  healthReason: string;
};

export type AlertState = {
  consecutiveHealthFailures: number;
  lastSent: Map<Alert['kind'], number>;
};

export function initialAlertState(): AlertState {
  return { consecutiveHealthFailures: 0, lastSent: new Map() };
}

export function evaluateAlerts(input: AlertInputs, state: AlertState): Alert[] {
  const firing: Alert[] = [];

  const run = dailyRun(input.platformTimezone, input.now, '06:00');
  const backupToday =
    input.lastBackupOkAt !== null &&
    dailyRun(input.platformTimezone, input.lastBackupOkAt, '00:00').localDate === run.localDate;
  if (run.due && !backupToday) {
    firing.push({
      kind: 'backup_missing',
      values: {
        timezone: input.platformTimezone,
        lastBackupAt: input.lastBackupOkAt?.toISOString() ?? null,
      },
    });
  }
  if ((input.jobs?.failed ?? 0) > 0)
    firing.push({ kind: 'events_failed', values: { failed: input.jobs?.failed ?? 0 } });
  if ((input.jobs?.oldestPendingSeconds ?? 0) > STUCK_LIMIT_SECONDS) {
    firing.push({
      kind: 'events_stuck',
      values: {
        oldestPendingSeconds: input.jobs?.oldestPendingSeconds ?? 0,
        limitSeconds: STUCK_LIMIT_SECONDS,
      },
    });
  }
  state.consecutiveHealthFailures = input.healthOk ? 0 : state.consecutiveHealthFailures + 1;
  if (state.consecutiveHealthFailures >= 2) {
    firing.push({
      kind: 'health_red',
      values: { consecutive: state.consecutiveHealthFailures, reason: input.healthReason },
    });
  }
  if (input.lastRestoreTest?.status === 'failed') {
    firing.push({
      kind: 'restore_test_failed',
      values: { reason: 'see ops_runs', lastOkAt: input.lastRestoreOkAt?.toISOString() ?? null },
    });
  }

  const nowMs = input.now.getTime();
  const firingKinds = new Set(firing.map((a) => a.kind));
  for (const kind of [...state.lastSent.keys()]) {
    if (!firingKinds.has(kind)) state.lastSent.delete(kind); // cleared → re-arm
  }
  return firing.filter((a) => {
    const last = state.lastSent.get(a.kind);
    if (last !== undefined && nowMs - last < RENOTIFY_MS) return false;
    state.lastSent.set(a.kind, nowMs);
    return true;
  });
}
