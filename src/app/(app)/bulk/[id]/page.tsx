import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { z } from 'zod';
import { ForbiddenState } from '@/components/admin/forbidden-state';
import { PageHeader } from '@/components/admin/page-header';
import { AutoRefresh } from '@/components/shell/auto-refresh';
import { Screen } from '@/components/shell/screen';
import { PermissionDeniedError } from '@/server/auth/permissions';
import { NotFoundError, withTenantPage } from '@/server/auth/with-tenant';
import { getBulkReport } from '@/server/bulk/service';

export const dynamic = 'force-dynamic';

const STATUSES = ['ok', 'failed', 'skipped', 'pending'] as const;

// Report of a bulk run (5.1): totals and the outcome per item; refreshes while the worker runs.
export default async function BulkReportPage({ params }: { params: Promise<{ id: string }> }) {
  const parsed = z.object({ id: z.uuid() }).safeParse(await params);
  if (!parsed.success) notFound();
  const locale = await getLocale();
  let report;
  try {
    report = await withTenantPage((ctx) => getBulkReport(ctx, parsed.data.id));
  } catch (error) {
    if (error instanceof PermissionDeniedError) return <ForbiddenState />;
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const t = await getTranslations('bulk');
  const errorText = (code: string) => {
    const key = `itemError.${code}` as const;
    return t.has(key as 'itemError.not_found') ? t(key as 'itemError.not_found') : code;
  };
  const running = report.status === 'queued' || report.status === 'running';
  const skipped = report.itemCount - report.okCount - report.failedCount;
  return (
    <Screen mobileClass="mobile-compact">
      <PageHeader
        title={t('reportTitle', { action: t(`actions.${report.action}`) })}
        description={t('reportDescription', {
          date: new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
            new Date(report.createdAt),
          ),
        })}
      />
      {running ? <AutoRefresh seconds={2} /> : null}
      <section
        className="rounded-lg border border-border bg-surface p-4"
        data-bulk-report={report.status}
      >
        <p className="font-medium text-text">{t(`runStatus.${report.status as 'queued'}`)}</p>
        <p className="text-sm text-text-muted">
          {t('totals', {
            total: report.itemCount,
            ok: report.okCount,
            failed: report.failedCount,
            skipped: running ? 0 : skipped,
          })}
        </p>
        {report.hasFile ? (
          <a
            href={`/api/bulk/${report.id}/file`}
            className="mt-3 inline-flex min-h-11 items-center rounded-md bg-brand-green px-4 font-medium text-surface"
            data-bulk-file
          >
            {t('download')}
          </a>
        ) : null}
      </section>
      <ul className="mt-4 flex flex-col gap-1">
        {report.items.map((i) => (
          <li
            key={i.id}
            className="flex min-h-11 flex-wrap items-center gap-2 rounded-md border border-border bg-surface px-3 text-sm"
            data-bulk-item={i.status}
          >
            {report.entity === 'customers' ? (
              <Link href={`/customers/${i.id}`} className="flex-1 text-brand-purple underline">
                {i.label ?? t('naturalPerson')}
              </Link>
            ) : (
              <span className="flex-1 text-text">{i.label ?? t('naturalPerson')}</span>
            )}
            <span className="text-text-muted">
              {t(
                `itemStatus.${(STATUSES as readonly string[]).includes(i.status) ? (i.status as 'ok') : 'pending'}`,
              )}
              {i.error ? ` · ${errorText(i.error)}` : ''}
            </span>
          </li>
        ))}
      </ul>
    </Screen>
  );
}
