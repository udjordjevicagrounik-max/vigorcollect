import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { z } from 'zod';
import { AgingBars } from '@/components/receivables/aging-bars';
import { KpiCard } from '@/components/receivables/kpi-card';
import { EmptyState } from '@/components/shell/empty-state';
import { Screen } from '@/components/shell/screen';
import { formatAmount } from '@/lib/format-amount';
import { PermissionDeniedError } from '@/server/auth/permissions';
import { withTenantPage } from '@/server/auth/with-tenant';
import { codeLabels, getDashboard, myWorkToday } from '@/server/receivables/service';

export const dynamic = 'force-dynamic';

const WORK_MODES = ['own', 'team'] as const;
const CURRENT = 'page' as const;

const searchSchema = z
  .object({ work: z.enum(['own', 'team']).catch('own') })
  .catch({ work: 'own' });

// Dashboard (task 2.3), mobile-full: KPIs with definitions (docs/metrics.md), aging, my work
// today (OWN / TEAM), drill-down to the customer. Before the first import: the empty state.
export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { work } = searchSchema.parse(await searchParams);
  const locale = await getLocale();
  let data;
  try {
    data = await withTenantPage(async (ctx) => {
      const dashboard = await getDashboard(ctx);
      const hasInvoices = dashboard.aging.some((a) => a.count > 0) || dashboard.openCases > 0;
      return {
        dashboard,
        hasInvoices,
        work: hasInvoices ? await myWorkToday(ctx, work) : [],
        buckets: await codeLabels(ctx, 'aging_bucket', locale),
        stages: await codeLabels(ctx, 'case_stage', locale),
        actions: await codeLabels(ctx, 'next_action', locale),
      };
    });
  } catch (error) {
    if (!(error instanceof PermissionDeniedError)) throw error;
    data = null;
  }
  const t = await getTranslations('dashboard');
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
  const d = data.dashboard;
  const money = (v: string) => formatAmount(v, d.currency, locale);
  const fxNote = d.missingFx ? t('missingFx', { n: d.missingFx }) : null;
  return (
    <Screen mobileClass="mobile-full">
      <header className="mb-4">
        <h1 className="text-xl font-semibold text-brand-green">{t('title')}</h1>
        <span aria-hidden="true" className="mt-2 block h-[3px] w-12 bg-brand-gold" />
        <p className="mt-3 max-w-prose text-text-muted">
          {t('description', { currency: d.currency })}
        </p>
      </header>
      <section
        aria-label={t('kpiLabel')}
        className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
      >
        <KpiCard
          id="overdue_total"
          label={t('kpi.overdue_total.label')}
          value={money(d.overdueTotal)}
          definition={t('kpi.overdue_total.definition')}
          definitionLabel={t('definition')}
          note={fxNote}
          href="/customers?overdue=1"
        />
        <KpiCard
          id="open_total"
          label={t('kpi.open_total.label')}
          value={money(d.openTotal)}
          definition={t('kpi.open_total.definition')}
          definitionLabel={t('definition')}
          note={fxNote}
          href="/customers"
        />
        <KpiCard
          id="dso"
          label={t('kpi.dso.label')}
          value={d.dso ? t('days', { n: d.dso }) : '—'}
          definition={t('kpi.dso.definition', { window: d.dsoWindowDays })}
          definitionLabel={t('definition')}
        />
        <KpiCard
          id="promises_today"
          label={t('kpi.promises_today.label')}
          value={`${d.promisesToday.count} · ${money(d.promisesToday.amount)}`}
          definition={t('kpi.promises_today.definition')}
          definitionLabel={t('definition')}
        />
        <KpiCard
          id="promises_broken"
          label={t('kpi.promises_broken.label')}
          value={d.promisesBroken}
          definition={t('kpi.promises_broken.definition')}
          definitionLabel={t('definition')}
        />
        <KpiCard
          id="open_cases"
          label={t('kpi.open_cases.label')}
          value={d.openCases}
          definition={t('kpi.open_cases.definition')}
          definitionLabel={t('definition')}
        />
        <KpiCard
          id="collected_30"
          label={t('kpi.collected_30.label')}
          value={money(d.collected30)}
          definition={t('kpi.collected_30.definition')}
          definitionLabel={t('definition')}
        />
        <KpiCard
          id="collection_rate"
          label={t('kpi.collection_rate.label')}
          value={d.collectionRate ? t('percent', { n: d.collectionRate }) : '—'}
          definition={t('kpi.collection_rate.definition')}
          definitionLabel={t('definition')}
        />
      </section>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <section
          aria-labelledby="aging-title"
          className="rounded-lg border border-border bg-surface p-4"
        >
          <h2 id="aging-title" className="font-semibold text-text">
            {t('aging.title')}
          </h2>
          <p className="mb-3 text-xs text-text-muted">{t('aging.definition')}</p>
          <AgingBars aging={d.aging} labels={data.buckets} currency={d.currency} locale={locale} />
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
                        {money(c.overdue)} · {t('days', { n: c.oldestDaysOverdue })}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </section>

        <section
          aria-labelledby="work-title"
          className="rounded-lg border border-border bg-surface p-4"
          data-my-work={work}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="work-title" className="font-semibold text-text">
              {t('work.title')}
            </h2>
            <nav aria-label={t('work.modeLabel')} className="flex gap-1 text-sm">
              {WORK_MODES.map((m) => (
                <Link
                  key={m}
                  href={`/?work=${m}`}
                  aria-current={work === m ? CURRENT : undefined}
                  className={`inline-flex min-h-11 items-center rounded-md px-3 ${work === m ? 'bg-brand-green text-surface' : 'border border-border text-text'}`}
                >
                  {t(`work.${m}`)}
                </Link>
              ))}
            </nav>
          </div>
          <p className="mt-1 text-xs text-text-muted">{t('work.definition')}</p>
          {data.work.length === 0 ? (
            <p className="mt-3 text-text-muted">{t('work.empty')}</p>
          ) : (
            <ul className="mt-3 flex flex-col gap-2 text-sm">
              {data.work.map((w) => (
                <li key={`${w.kind}-${w.refId}`} data-work-item={w.kind}>
                  <Link
                    href={`/customers/${w.customerId}${w.kind === 'case' ? `/cases/${w.refId}` : ''}`}
                    className="block rounded-md border border-border p-2 hover:bg-brand-purple-soft"
                  >
                    <span className="font-medium text-text">
                      {w.customerName ?? t('naturalPerson')}
                    </span>
                    <span className="block text-text-muted">
                      {w.kind === 'promise_due' && w.amount && w.currency
                        ? t('work.promise', {
                            amount: formatAmount(w.amount, w.currency, locale),
                            date: w.date ?? '',
                          })
                        : w.kind === 'next_action'
                          ? t('work.nextAction', {
                              action: (w.code && data.actions[w.code]) || w.code || '',
                              date: w.date ?? '',
                            })
                          : t('work.case', {
                              stage: (w.code && data.stages[w.code]) || w.code || '',
                            })}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Screen>
  );
}
