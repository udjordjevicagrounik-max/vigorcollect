import Link from 'next/link';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { z } from 'zod';
import { AttentionList } from '@/components/communication/attention-list';
import { DashboardGrid, ReportWidget } from '@/components/dashboard/dashboard-grid';
import { AgingBars } from '@/components/receivables/aging-bars';
import { KpiCard } from '@/components/receivables/kpi-card';
import { EmptyState } from '@/components/shell/empty-state';
import { Screen } from '@/components/shell/screen';
import { formatAmount } from '@/lib/format-amount';
import { PermissionDeniedError } from '@/server/auth/permissions';
import { withTenantPage } from '@/server/auth/with-tenant';
import {
  dashboardData,
  homeDashboardId,
  listDashboards,
  type Figures,
  type KpiKey,
  type WidgetData,
} from '@/server/dashboards/service';
import { getDashboard } from '@/server/receivables/service';
import { listReportDefinitions } from '@/server/reporting/service';

export const dynamic = 'force-dynamic';

const TIME_SHORT = { timeStyle: 'short' } as const;

const searchSchema = z
  .object({
    d: z.uuid().optional().catch(undefined),
    refresh: z.enum(['1']).optional().catch(undefined),
  })
  .catch({});

// Home (6.3) = the member's default dashboard (own choice → role default → the system
// "Collections overview", the 2.3 dashboard in the widget model). Before the first import: the
// empty state.
export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const q = searchSchema.parse(await searchParams);
  const locale = await getLocale();
  let data;
  try {
    data = await withTenantPage(async (ctx) => {
      const figures = await getDashboard(ctx);
      const hasInvoices = figures.aging.some((a) => a.count > 0) || figures.openCases > 0;
      if (!hasInvoices) return { hasInvoices: false as const };
      const id = q.d ?? (await homeDashboardId(ctx));
      return {
        hasInvoices: true as const,
        currency: figures.currency,
        board: await dashboardData(ctx, id, locale, { refresh: q.refresh === '1' }),
        dashboards: await listDashboards(ctx),
        reports: (await listReportDefinitions(ctx).catch(() => [])).map((r) => ({
          id: r.id,
          name: r.name,
        })),
      };
    });
  } catch (error) {
    if (!(error instanceof PermissionDeniedError)) throw error;
    data = null;
  }
  const t = await getTranslations('dashboard');
  const tr = await getTranslations('reports');
  const tErrors = await getTranslations('errors');
  if (!data || !data.hasInvoices) {
    return (
      <Screen mobileClass="mobile-full">
        <EmptyState
          title={t('empty.title')}
          description={t('empty.description')}
          actionLabel={t('empty.action')}
          actionHref="/import"
        />
      </Screen>
    );
  }
  const format = await getFormatter();
  const { board } = data;
  const nameOf = (n: string, key: string | null) =>
    key === 'collections_overview' ? t('title') : n;

  const kpi = (key: KpiKey, d: Figures) => {
    const money = (v: string) => formatAmount(v, d.currency, locale);
    const fxNote = d.missingFx ? t('missingFx', { n: d.missingFx }) : null;
    const values: Record<
      KpiKey,
      { value: string | number; note?: string | null; href?: string; window?: boolean }
    > = {
      overdue_total: { value: money(d.overdueTotal), note: fxNote, href: '/customers?overdue=1' },
      open_total: { value: money(d.openTotal), note: fxNote, href: '/customers' },
      dso: { value: d.dso ? t('days', { n: d.dso }) : '—', window: true },
      promises_today: { value: `${d.promisesToday.count} · ${money(d.promisesToday.amount)}` },
      promises_broken: { value: d.promisesBroken },
      disputed: {
        value: t('kpi.disputed.count', { amount: money(d.disputedTotal), n: d.openDisputes }),
        note: fxNote,
      },
      open_cases: { value: d.openCases },
      collected_30: { value: money(d.collected30) },
      collection_rate: { value: d.collectionRate ? t('percent', { n: d.collectionRate }) : '—' },
    };
    const v = values[key];
    return (
      <KpiCard
        id={key}
        label={t(`kpi.${key}.label`)}
        value={v.value}
        definition={
          v.window
            ? t('kpi.dso.definition', { window: d.dsoWindowDays })
            : t(`kpi.${key}.definition` as 'kpi.open_total.definition')
        }
        definitionLabel={t('definition')}
        note={v.note ?? null}
        {...(v.href ? { href: v.href } : {})}
      />
    );
  };

  const body = (w: (typeof board.widgets)[number], wd: WidgetData | undefined) => {
    if (!wd) return null;
    if (wd.kind === 'error')
      return (
        <p
          className="rounded-lg border border-border bg-surface p-4 text-sm text-text-muted"
          role="status"
        >
          {tErrors.has(wd.code as 'forbidden') ? tErrors(wd.code as 'forbidden') : wd.code}
        </p>
      );
    if (wd.kind === 'kpi' && w.kpiKey) return kpi(w.kpiKey, wd.figures);
    if (wd.kind === 'aging') {
      const d = wd.figures;
      return (
        <section
          aria-labelledby={`aging-${w.id}`}
          className="h-full rounded-lg border border-border bg-surface p-4"
        >
          <h2 id={`aging-${w.id}`} className="font-semibold text-text">
            {w.title ?? t('aging.title')}
          </h2>
          <p className="mb-3 text-xs text-text-muted">{t('aging.definition')}</p>
          <AgingBars aging={d.aging} labels={wd.buckets} currency={d.currency} locale={locale} />
          {d.topOverdue.length ? (
            <>
              <h3 className="mt-4 text-sm font-semibold text-text">{t('topOverdue')}</h3>
              <ul className="mt-2 flex flex-col gap-1 text-sm">
                {d.topOverdue.map((c) => (
                  <li key={c.id}>
                    <Link
                      href={`/customers/${c.id}`}
                      className="flex min-h-11 items-center justify-between gap-2 rounded-md px-2 hover:bg-brand-purple-soft"
                      data-drill-customer
                    >
                      <span className="truncate text-text">
                        {c.displayName ?? t('naturalPerson')}
                      </span>
                      <span className="whitespace-nowrap font-medium text-text">
                        {formatAmount(c.overdue, d.currency, locale)} ·{' '}
                        {t('days', { n: c.oldestDaysOverdue })}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </section>
      );
    }
    if (wd.kind === 'attention') return <AttentionList items={wd.items} locale={locale} />;
    if (wd.kind === 'my_tasks' || wd.kind === 'team_attention')
      return (
        <section
          className="h-full rounded-lg border border-border bg-surface p-4"
          data-my-work={wd.kind === 'my_tasks' ? 'own' : 'team'}
        >
          <h2 className="font-semibold text-text">
            {w.title ?? t(wd.kind === 'my_tasks' ? 'work.title' : 'work.teamTitle')}
          </h2>
          <p className="mt-1 text-xs text-text-muted">{t('work.definition')}</p>
          {wd.items.length === 0 ? (
            <p className="mt-3 text-text-muted">{t('work.empty')}</p>
          ) : (
            <ul className="mt-3 flex flex-col gap-2 text-sm">
              {wd.items.map((it) => (
                <li key={`${it.kind}-${it.refId}`} data-work-item={it.kind}>
                  <Link
                    href={`/customers/${it.customerId}${it.kind === 'case' ? `/cases/${it.refId}` : ''}`}
                    className="block rounded-md border border-border p-2 hover:bg-brand-purple-soft"
                  >
                    <span className="font-medium text-text">
                      {it.customerName ?? t('naturalPerson')}
                    </span>
                    <span className="block text-text-muted">
                      {it.kind === 'promise_due' && it.amount && it.currency
                        ? t('work.promise', {
                            amount: formatAmount(it.amount, it.currency, locale),
                            date: it.date ?? '',
                          })
                        : it.kind === 'next_action'
                          ? t('work.nextAction', {
                              action: (it.code && wd.actions[it.code]) || it.code || '',
                              date: it.date ?? '',
                            })
                          : t('work.case', {
                              stage: (it.code && wd.stages[it.code]) || it.code || '',
                            })}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      );
    if (wd.kind === 'report') {
      const title =
        w.title ??
        (wd.systemKey && tr.has(`names.${wd.systemKey}` as 'names.disputes')
          ? tr(`names.${wd.systemKey}` as 'names.disputes')
          : wd.name);
      return (
        <section
          className="h-full rounded-lg border border-border bg-surface p-4"
          data-widget-report={w.reportId}
        >
          <h2 className="mb-2 font-semibold text-text">
            <Link href={`/reports/${w.reportId}`} className="hover:underline">
              {title}
            </Link>
          </h2>
          <ReportWidget data={wd.data} visual={wd.visual} definition={wd.definition} />
        </section>
      );
    }
    return null;
  };

  return (
    <Screen mobileClass="mobile-full">
      <header className="mb-4">
        <h1 className="text-xl font-semibold text-brand-green">
          {nameOf(board.dashboard.name, board.dashboard.systemKey)}
        </h1>
        <span aria-hidden="true" className="mt-2 block h-[3px] w-12 bg-brand-gold" />
        <p className="mt-3 max-w-prose text-text-muted">
          {t('description', { currency: data.currency })}
        </p>
      </header>
      <DashboardGrid
        dashboard={{
          id: board.dashboard.id,
          name: nameOf(board.dashboard.name, board.dashboard.systemKey),
          isSystem: board.dashboard.isSystem,
          mine: board.dashboard.mine,
        }}
        dashboards={data.dashboards.map((d) => ({
          id: d.id,
          name: nameOf(d.name, d.systemKey),
          isSystem: d.isSystem,
          mine: d.mine,
        }))}
        reports={data.reports.map((r) => ({ id: r.id, name: r.name }))}
        cachedAt={format.dateTime(new Date(board.cachedAt), TIME_SHORT)}
        items={board.widgets.map((w) => ({
          id: w.id,
          size: w.size,
          title: w.title,
          kind: w.kind,
          body: body(w, board.data[w.id]),
        }))}
      />
    </Screen>
  );
}
