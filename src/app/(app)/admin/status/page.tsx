import { getTranslations } from 'next-intl/server';
import { ForbiddenState } from '@/components/admin/forbidden-state';
import { PageHeader } from '@/components/admin/page-header';
import { Screen } from '@/components/shell/screen';
import { getAppVersion } from '@/lib/version';
import { PermissionDeniedError } from '@/server/auth/permissions';
import { withTenantPage } from '@/server/auth/with-tenant';
import { healthReport, liveHealthDeps } from '@/server/health';

export const dynamic = 'force-dynamic';

// Admin → System status (rule 94): the same facts as /health, read-only, for settings.read.
export default async function SystemStatusPage() {
  try {
    await withTenantPage(async (ctx) => ctx.requirePermission('settings.read'));
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
    </Screen>
  );
}
