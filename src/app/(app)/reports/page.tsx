import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { z } from 'zod';
import { ForbiddenState } from '@/components/admin/forbidden-state';
import { PageHeader } from '@/components/admin/page-header';
import { ExportButton } from '@/components/reports/export-button';
import { SavedReports } from '@/components/reports/saved-reports';
import { Screen } from '@/components/shell/screen';
import { formatAmount } from '@/lib/format-amount';
import { PermissionDeniedError, permissionKeys } from '@/server/auth/permissions';
import { withTenantPage } from '@/server/auth/with-tenant';
import { listExportFiles } from '@/server/exports/tables';
import { codeLabels } from '@/server/receivables/service';
import {
  listSavedReports,
  REPORT_KEYS,
  reportConfig,
  runReport,
  type ReportConfig,
  type ReportKey,
} from '@/server/reports/service';

export const dynamic = 'force-dynamic';

const searchSchema = z.object({
  report: z.enum(REPORT_KEYS).catch('aging_by_customer'),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .catch(undefined),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .catch(undefined),
  owner: z.enum(['me']).optional().catch(undefined),
  groupBy: z.enum(['owner', 'team']).optional().catch(undefined),
  period: z.enum(['day', 'week', 'month']).optional().catch(undefined),
  sort: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,62}$/)
    .optional()
    .catch(undefined),
  dir: z.enum(['asc', 'desc']).optional().catch(undefined),
});
const PERIODS = ['day', 'week', 'month'] as const;
const GROUP_OWNER = 'owner';
const GROUP_TEAM = 'team';
const ME = 'me';
const DATED: ReportKey[] = ['collected_by_period', 'promises', 'disputes'];
const field = 'min-h-11 rounded-md border border-border bg-surface px-3';

function toHref(report: ReportKey, config: ReportConfig): string {
  const p = new URLSearchParams({ report });
  for (const [k, v] of Object.entries(config.filters)) if (v) p.set(k, String(v));
  if (config.sort) {
    p.set('sort', config.sort.column);
    p.set('dir', config.sort.dir);
  }
  return `/reports?${p.toString()}`;
}

// Reports (5.2), mobile-compact: the six base reports (docs/metrics.md), filters in the URL
// (dates / codes only), saved reports per member or shared, export through exportService.
export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const q = searchSchema.parse(await searchParams);
  const config = reportConfig.parse({
    filters: { from: q.from, to: q.to, owner: q.owner, groupBy: q.groupBy, period: q.period },
    sort: q.sort ? { column: q.sort, dir: q.dir ?? 'desc' } : undefined,
  });
  const locale = await getLocale();
  let data;
  try {
    data = await withTenantPage(async (ctx) => {
      const keys = await permissionKeys(ctx.db, ctx.userId);
      return {
        result: await runReport(ctx, q.report, config),
        saved: await listSavedReports(ctx),
        exports: keys.has('export.read') ? await listExportFiles(ctx) : [],
        canExport: keys.has('report.export'),
        labels: {
          ...(await codeLabels(ctx, 'aging_bucket', locale)),
          ...(await codeLabels(ctx, 'case_stage', locale)),
          ...(await codeLabels(ctx, 'dispute_reason', locale)),
        },
      };
    });
  } catch (error) {
    if (error instanceof PermissionDeniedError) return <ForbiddenState />;
    throw error;
  }
  const t = await getTranslations('reports');
  const tExports = await getTranslations('exports');
  const r = data.result;
  const expiry = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });
  const exportTexts = {
    mine: tExports('mine'),
    empty: tExports('mineEmpty'),
    download: tExports('download'),
  };
  const exportLines = data.exports.map((e) => ({
    ...e,
    line: tExports('fileLine', {
      type: e.exportType,
      format: e.format.toUpperCase(),
      rows: e.rowCount ?? 0,
      date: expiry.format(new Date(e.expiresAt)),
    }),
    state: e.status === 'ready' ? null : tExports(`status.${e.status as 'queued'}`),
  }));
  const columnLabel = (c: { key: string; label?: string }) =>
    c.label
      ? (data.labels[c.label] ?? c.label)
      : t.has(`columns.${c.key}` as 'columns.customer')
        ? t(`columns.${c.key}` as 'columns.customer')
        : c.key;
  const cell = (c: { key: string; type: string }, v: string | number | null | undefined) => {
    if (v === null || v === undefined) return c.key === 'owner' ? t('noOwner') : '—';
    if (c.type === 'amount') return formatAmount(String(v), r.currency, locale);
    if (c.key === 'stage' || c.key === 'reason') return data.labels[String(v)] ?? String(v);
    return String(v);
  };
  return (
    <Screen mobileClass="mobile-compact">
      <PageHeader title={t('title')} description={t('description', { currency: r.currency })} />
      <form
        method="get"
        className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 md:flex-row md:flex-wrap md:items-end"
        data-report-form
      >
        <label className="flex flex-col gap-1 text-sm font-medium text-text">
          {t('choose')}
          <select name="report" defaultValue={q.report} className={field}>
            {REPORT_KEYS.map((k) => (
              <option key={k} value={k}>
                {t(`names.${k}`)}
              </option>
            ))}
          </select>
        </label>
        {DATED.includes(q.report) ? (
          <>
            <label className="flex flex-col gap-1 text-sm font-medium text-text">
              {t('from')}
              <input type="date" name="from" defaultValue={q.from ?? ''} className={field} />
            </label>
            <label className="flex flex-col gap-1 text-sm font-medium text-text">
              {t('to')}
              <input type="date" name="to" defaultValue={q.to ?? ''} className={field} />
            </label>
          </>
        ) : null}
        {q.report === 'collected_by_period' ? (
          <label className="flex flex-col gap-1 text-sm font-medium text-text">
            {t('period')}
            <select name="period" defaultValue={q.period ?? 'month'} className={field}>
              {PERIODS.map((p) => (
                <option key={p} value={p}>
                  {t(`periods.${p}`)}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {q.report === 'aging_by_collector' ? (
          <label className="flex flex-col gap-1 text-sm font-medium text-text">
            {t('groupBy')}
            <select name="groupBy" defaultValue={q.groupBy ?? 'owner'} className={field}>
              <option value={GROUP_OWNER}>{t('groupByOwner')}</option>
              <option value={GROUP_TEAM}>{t('groupByTeam')}</option>
            </select>
          </label>
        ) : null}
        <label className="flex flex-col gap-1 text-sm font-medium text-text">
          {t('sortBy')}
          <select name="sort" defaultValue={q.sort ?? ''} className={field}>
            <option value="">{t('sortDefault')}</option>
            {r.columns.map((c) => (
              <option key={c.key} value={c.key}>
                {columnLabel(c)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-h-11 items-center gap-2 text-sm text-text">
          <input
            type="checkbox"
            name="owner"
            value={ME}
            defaultChecked={q.owner === 'me'}
            className="size-5"
          />
          {t('onlyMine')}
        </label>
        <button
          type="submit"
          className="min-h-11 rounded-md bg-brand-green px-4 font-medium text-surface hover:bg-brand-green-deep"
        >
          {t('apply')}
        </button>
      </form>

      <section className="mt-4 rounded-lg border border-border bg-surface p-4" data-report={r.key}>
        <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
          <div>
            <h2 className="font-semibold text-brand-green">{t(`names.${r.key}`)}</h2>
            <p className="mt-1 max-w-prose text-sm text-text-muted">{t(`definitions.${r.key}`)}</p>
          </div>
          {data.canExport ? <ExportButton type={`report.${r.key}`} filters={config} /> : null}
        </div>
        {r.rows.length === 0 ? (
          <p className="mt-4 text-sm text-text-muted" data-report-empty>
            {t('empty')}
          </p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-text-muted">
                <tr>
                  {r.columns.map((c) => (
                    <th
                      key={c.key}
                      className={`whitespace-nowrap p-2 font-medium ${c.type === 'amount' || c.type === 'int' ? 'text-right' : ''}`}
                    >
                      {columnLabel(c)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {r.rows.map((row, i) => (
                  <tr key={i} className="border-t border-border">
                    {r.columns.map((c) => (
                      <td
                        key={c.key}
                        className={`whitespace-nowrap p-2 ${c.type === 'amount' || c.type === 'int' ? 'text-right' : ''}`}
                      >
                        {c.key === 'customer' && row[c.key] === null
                          ? t('naturalPerson')
                          : cell(c, row[c.key])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <SavedReports
        reportKey={r.key}
        config={config}
        saved={data.saved
          .filter((s) => s.reportKey === r.key)
          .map((s) => ({
            id: s.id,
            name: s.name,
            shared: s.shared,
            mine: s.mine,
            href: toHref(s.reportKey, s.config),
          }))}
      />

      <section className="mt-4 rounded-lg border border-border bg-surface p-4" data-my-exports>
        <h2 className="font-semibold text-brand-green">{exportTexts.mine}</h2>
        {exportLines.length === 0 ? (
          <p className="mt-2 text-sm text-text-muted">{exportTexts.empty}</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1">
            {exportLines.map((e) => (
              <li key={e.id} className="flex min-h-11 flex-wrap items-center gap-2 text-sm">
                <span className="flex-1 text-text">{e.line}</span>
                {e.state === null ? (
                  <Link
                    href={`/api/exports/${e.id}/download`}
                    prefetch={false}
                    className="text-brand-purple underline"
                  >
                    {exportTexts.download}
                  </Link>
                ) : (
                  <span className="text-text-muted">{e.state}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </Screen>
  );
}
