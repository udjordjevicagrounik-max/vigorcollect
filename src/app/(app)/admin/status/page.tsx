import { getTranslations } from 'next-intl/server';
import { DailyRunButton } from '@/components/admin/daily-run-button';
import { ForbiddenState } from '@/components/admin/forbidden-state';
import { PageHeader } from '@/components/admin/page-header';
import { Screen } from '@/components/shell/screen';
import { getAppVersion } from '@/lib/version';
import { PermissionDeniedError, permissionKeys } from '@/server/auth/permissions';
import { withTenantPage } from '@/server/auth/with-tenant';
import { alertChannels, type AlertEnv } from '@/server/alerts/adapter';
import { healthReport, liveHealthDeps } from '@/server/health';
import { isSentryEnabled } from '@/server/observability/sentry';

export const dynamic = 'force-dynamic';

// Admin → System status (rule 94): the same facts as /health, read-only, for settings.read.
export default async function SystemStatusPage() {
  let ops: {
    backupAt: Date | null;
    backupStale: boolean;
    restore: { status: string; at: Date } | null;
    canRunDaily: boolean;
  };
  try {
    ops = await withTenantPage(async (ctx) => {
      await ctx.requirePermission('settings.read');
      // A backup older than 26 h means last night's run is missing.
      const backup = await ctx.db.query<{ at: Date; stale: boolean }>(
        `SELECT finished_at AS at, finished_at < now() - interval '26 hours' AS stale
         FROM ops_runs WHERE kind = 'backup' AND status = 'ok'
         ORDER BY finished_at DESC LIMIT 1`,
      );
      const restore = await ctx.db.query<{ status: string; at: Date }>(
        `SELECT status, finished_at AS at FROM ops_runs WHERE kind = 'restore_test'
         ORDER BY finished_at DESC LIMIT 1`,
      );
      return {
        backupAt: backup.rows[0]?.at ?? null,
        backupStale: backup.rows[0]?.stale ?? true,
        restore: restore.rows[0] ?? null,
        canRunDaily: (await permissionKeys(ctx.db, ctx.userId)).has('settings.manage'),
      };
    });
  } catch (error) {
    if (error instanceof PermissionDeniedError) return <ForbiddenState />;
    throw error;
  }
  const report = await healthReport(liveHealthDeps);
  const t = await getTranslations('admin.status');
  const jobs = report.jobs;
  const rows: { label: string; value: string; danger?: boolean }[] = [
    {
      label: t('db'),
      value: report.db === 'ok' ? t('dbOk') : t('dbDown'),
      danger: report.db !== 'ok',
    },
    ...(jobs && jobs.pending !== null
      ? [
          { label: t('pending'), value: String(jobs.pending) },
          { label: t('failed'), value: String(jobs.failed ?? 0), danger: (jobs.failed ?? 0) > 0 },
          {
            label: t('oldestPending'),
            value:
              jobs.oldestPendingSeconds === null
                ? '—'
                : t('seconds', { count: jobs.oldestPendingSeconds }),
          },
          { label: t('lastRetention'), value: jobs.lastRetentionAt ?? t('never') },
        ]
      : []),
    { label: t('version'), value: getAppVersion() },
  ];
  const channels = alertChannels(process.env as AlertEnv);
  const opsRows: { label: string; value: string; danger?: boolean }[] = [
    {
      label: t('lastBackup'),
      value: ops.backupAt ? ops.backupAt.toISOString() : t('never'),
      danger: ops.backupStale,
    },
    {
      label: t('lastRestore'),
      value: ops.restore
        ? t(ops.restore.status === 'ok' ? 'restoreOk' : 'restoreFailed', {
            date: ops.restore.at.toISOString(),
          })
        : t('never'),
      danger: ops.restore?.status !== 'ok',
    },
    {
      label: t('sentry'),
      value: isSentryEnabled() ? t('connected') : t('notConnected'),
      danger: !isSentryEnabled(),
    },
    {
      label: t('alerts'),
      value: channels.length ? t('channels', { channels: channels.join(', ') }) : t('logOnly'),
      danger: channels.length === 0,
    },
  ];
  return (
    <Screen mobileClass="mobile-full">
      <PageHeader title={t('title')} description={t('description')} />
      {jobs?.pending === null || !jobs ? (
        <p
          role="status"
          className="mb-4 rounded-md border border-status-info-fg bg-status-info-bg p-3 text-sm text-status-info-fg"
        >
          {t('notStarted')}
        </p>
      ) : null}
      <dl className="divide-y divide-border rounded-lg border border-border bg-surface">
        {rows.map((row) => (
          <div
            key={row.label}
            className="flex flex-wrap items-center justify-between gap-2 px-4 py-3"
          >
            <dt className="text-text-muted">{row.label}</dt>
            <dd
              className={row.danger ? 'font-medium text-status-danger-fg' : 'font-medium text-text'}
            >
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
      {ops.canRunDaily ? (
        <section aria-labelledby="daily-run-title" className="mt-6">
          <h2 id="daily-run-title" className="mb-2 font-semibold text-text">
            {t('dailyRunTitle')}
          </h2>
          <DailyRunButton />
        </section>
      ) : null}
      <h2 className="mb-2 mt-6 font-semibold text-text">{t('ops')}</h2>
      <dl data-ops className="divide-y divide-border rounded-lg border border-border bg-surface">
        {opsRows.map((row) => (
          <div
            key={row.label}
            className="flex flex-wrap items-center justify-between gap-2 px-4 py-3"
          >
            <dt className="text-text-muted">{row.label}</dt>
            <dd
              className={row.danger ? 'font-medium text-status-danger-fg' : 'font-medium text-text'}
            >
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
    </Screen>
  );
}
