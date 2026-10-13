import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { z } from 'zod';
import { ForbiddenState } from '@/components/admin/forbidden-state';
import { GenerateDocument } from '@/components/communication/generate-document';
import { AgingBars } from '@/components/receivables/aging-bars';
import { CustomerActions, PromiseActions } from '@/components/receivables/customer-actions';
import { Screen } from '@/components/shell/screen';
import { formatAmount } from '@/lib/format-amount';
import { PermissionDeniedError, permissionKeys } from '@/server/auth/permissions';
import { NotFoundError, withTenantPage } from '@/server/auth/with-tenant';
import { localToday } from '@/server/collections/service';
import { listDocuments } from '@/server/documents/service';
import {
  codeLabels,
  customerActivities,
  customerCases,
  customerInvoices,
  customerPayments,
  customerPromises,
  getCustomer360,
} from '@/server/receivables/service';

export const dynamic = 'force-dynamic';

const TABS = [
  'overview',
  'invoices',
  'payments',
  'promises',
  'activities',
  'cases',
  'documents',
] as const;
type Tab = (typeof TABS)[number];
const TAB_PERMISSION: Record<Tab, string> = {
  overview: 'customer.read',
  invoices: 'invoice.read',
  payments: 'payment.read',
  promises: 'promise.read',
  activities: 'activity.read',
  cases: 'case.read',
  documents: 'document.read',
};
const KPIS = ['exposure', 'overdue', 'oldest', 'promises'] as const;
const CURRENT = 'page' as const;
const OVERDUE = 'overdue' as const;
const NONE = '—' as const;

const paramsSchema = z.object({ id: z.uuid() });
const searchSchema = z.object({ tab: z.enum(TABS).catch('overview') }).catch({ tab: 'overview' });

// Customer 360 (task 2.3), mobile-compact: header KPIs + tabs (overview with aging, invoices,
// payments, promises, activities, cases). Actions (case, promise, activity, payment) — 2.4.
export default async function Customer360Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const parsed = paramsSchema.safeParse(await params);
  if (!parsed.success) notFound();
  const { tab } = searchSchema.parse(await searchParams);
  const id = parsed.data.id;
  const locale = await getLocale();
  let data;
  try {
    data = await withTenantPage(async (ctx) => {
      const customer = await getCustomer360(ctx, id);
      const keys = await permissionKeys(ctx.db, ctx.userId);
      const allowed = TABS.filter((x) => keys.has(TAB_PERMISSION[x]));
      const active: Tab = allowed.includes(tab) ? tab : 'overview';
      const invoicesAll = keys.has('invoice.read') ? await customerInvoices(ctx, id) : [];
      return {
        customer,
        allowed,
        active,
        keys: [...keys],
        today: (await localToday(ctx.db, customer.companyId)).today,
        openInvoices: invoicesAll
          .filter(
            (i) => i.amountOpen !== '0.00' && i.status !== 'credited' && i.status !== 'cancelled',
          )
          .map((i) => ({
            id: i.id,
            number: i.number,
            amountOpen: i.amountOpen,
            currency: i.currency,
            dueDate: i.dueDate,
          })),
        invoices: active === 'invoices' ? invoicesAll : [],
        payments: active === 'payments' ? await customerPayments(ctx, id) : [],
        promises: active === 'promises' ? await customerPromises(ctx, id) : [],
        activities: active === 'activities' ? await customerActivities(ctx, id) : [],
        cases:
          active === 'cases' || active === 'overview'
            ? keys.has('case.read')
              ? await customerCases(ctx, id)
              : []
            : [],
        buckets: await codeLabels(ctx, 'aging_bucket', locale),
        stages: await codeLabels(ctx, 'case_stage', locale),
        outcomes: await codeLabels(ctx, 'activity_outcome', locale),
        nextActions: await codeLabels(ctx, 'next_action', locale),
        reasons: await codeLabels(ctx, 'adjustment_reason', locale),
        documents: active === 'documents' ? await listDocuments(ctx, id) : [],
      };
    });
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    if (error instanceof PermissionDeniedError) return <ForbiddenState />;
    throw error;
  }
  const t = await getTranslations('customer360');
  const c = data.customer;
  const money = (v: string, cur = c.currency) => formatAmount(v, cur, locale);
  return (
    <Screen mobileClass="mobile-compact">
      <header className="mb-4">
        <p className="text-sm">
          <Link href="/customers" className="text-brand-purple underline">
            {t('back')}
          </Link>
        </p>
        <h1 className="mt-1 text-xl font-semibold text-brand-green" data-customer-name>
          {c.displayName ?? t('naturalPerson')}
        </h1>
        <span aria-hidden="true" className="mt-2 block h-[3px] w-12 bg-brand-gold" />
        <p className="mt-2 text-sm text-text-muted">
          {c.taxId ? `${t('taxId')} ${c.taxId} · ` : ''}
          {t(`statuses.${c.status as 'active' | 'inactive' | 'blocked'}`)} ·{' '}
          {c.ownerName ?? t('noOwner')}
        </p>
      </header>
      <dl className="grid grid-cols-2 gap-3 md:grid-cols-4" data-customer-kpis>
        {KPIS.map((k) => {
          const v = {
            exposure: money(c.exposure),
            overdue: money(c.overdue),
            oldest: c.oldestDaysOverdue ? t('days', { n: c.oldestDaysOverdue }) : NONE,
            promises: String(c.openPromises),
          }[k];
          return (
            <div
              key={k}
              className="rounded-lg border border-border bg-surface p-3"
              title={t(`kpi.${k}.definition`)}
            >
              <dt className="text-xs text-text-muted">{t(`kpi.${k}.label`)}</dt>
              <dd className="text-lg font-semibold text-text" data-kpi={k}>
                {v}
              </dd>
            </div>
          );
        })}
      </dl>
      {c.missingFx ? (
        <p className="mt-2 text-xs text-status-warning-fg">{t('missingFx', { n: c.missingFx })}</p>
      ) : null}

      <CustomerActions
        customerId={c.id}
        currency={data.openInvoices[0]?.currency ?? c.currency}
        today={data.today}
        permissions={data.keys}
        openInvoices={data.openInvoices}
        outcomes={data.outcomes}
        nextActions={data.nextActions}
      />

      <nav
        aria-label={t('tabsLabel')}
        className="mt-4 flex gap-1 overflow-x-auto border-b border-border"
      >
        {data.allowed.map((x) => (
          <Link
            key={x}
            href={`/customers/${c.id}?tab=${x}`}
            aria-current={data.active === x ? CURRENT : undefined}
            data-tab={x}
            className={`inline-flex min-h-11 shrink-0 items-center px-3 text-sm ${data.active === x ? 'border-b-2 border-brand-green font-semibold text-brand-green' : 'text-text-muted'}`}
          >
            {t(`tabs.${x}`)}
          </Link>
        ))}
      </nav>

      <section className="mt-4" data-tab-panel={data.active}>
        {data.active === 'overview' ? (
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-lg border border-border bg-surface p-4">
              <h2 className="font-semibold text-text">{t('aging')}</h2>
              <div className="mt-3">
                <AgingBars
                  aging={c.aging}
                  labels={data.buckets}
                  currency={c.currency}
                  locale={locale}
                />
              </div>
            </div>
            <div className="rounded-lg border border-border bg-surface p-4">
              <h2 className="font-semibold text-text">{t('openCases', { n: c.openCases })}</h2>
              <List
                empty={t('empty.cases')}
                items={data.cases
                  .filter((k) => k.status === 'open')
                  .map((k) => ({
                    key: k.id,
                    href: `/customers/${c.id}/cases/${k.id}`,
                    title: data.stages[k.stage] ?? k.stage,
                    line: `${t(`priority.${k.priority as 'normal'}`)} · ${money(k.amountOpen)} · ${k.ownerName ?? t('noOwner')}`,
                  }))}
              />
            </div>
          </div>
        ) : null}
        {data.active === 'invoices' ? (
          <List
            empty={t('empty.invoices')}
            items={data.invoices.map((i) => ({
              key: i.id,
              attr: i.isOverdue ? OVERDUE : i.status,
              title: `${i.number} · ${money(i.amountOpen, i.currency)}`,
              line: `${t('invoiceLine', { total: money(i.amountTotal, i.currency), due: i.dueDate })} · ${t(`invoiceStatus.${i.status as 'open'}`)}${i.isOverdue ? ` · ${t('days', { n: i.daysOverdue })}` : ''}`,
            }))}
          />
        ) : null}
        {data.active === 'payments' ? (
          <List
            empty={t('empty.payments')}
            items={data.payments.map((p) => ({
              key: p.id,
              attr: p.kind,
              title: `${p.paidOn} · ${money(p.amount, p.currency)}`,
              line: `${t(`paymentKind.${p.kind}`)}${p.reason ? ` (${data.reasons[p.reason] ?? p.reason})` : ''} · ${t('allocated', { amount: money(p.allocated, p.currency) })}${p.reference ? ` · ${p.reference}` : ''}`,
            }))}
          />
        ) : null}
        {data.active === 'promises' ? (
          data.promises.length === 0 ? (
            <p className="rounded-lg border border-border bg-surface p-4 text-text-muted">
              {t('empty.promises')}
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {data.promises.map((p) => (
                <li
                  key={p.id}
                  data-row={p.status}
                  className="rounded-lg border border-border bg-surface p-3"
                >
                  <span className="font-medium text-text">
                    {p.promisedOn} · {money(p.amount, p.currency)}
                  </span>
                  <span className="block text-sm text-text-muted" data-promise-status={p.status}>
                    {t(`promiseStatus.${p.status as 'pending'}`)}
                    {p.paidAmount
                      ? ` · ${t('paid', { amount: money(p.paidAmount, p.currency) })}`
                      : ''}
                  </span>
                  {p.status === 'pending' && data.keys.includes('promise.update') ? (
                    <PromiseActions promiseId={p.id} today={data.today} />
                  ) : null}
                </li>
              ))}
            </ul>
          )
        ) : null}
        {data.active === 'activities' ? (
          <List
            empty={t('empty.activities')}
            items={data.activities.map((a) => ({
              key: a.id,
              attr: a.kind,
              title: `${t(`activityKind.${a.kind as 'call'}`)}${a.outcome ? ` · ${data.outcomes[a.outcome] ?? a.outcome}` : ''}`,
              line: [
                a.occurredAt.slice(0, 10),
                a.actorName,
                a.nextAction
                  ? t('next', {
                      action: data.nextActions[a.nextAction] ?? a.nextAction,
                      date: a.nextActionOn ?? '',
                    })
                  : null,
                a.note,
              ]
                .filter(Boolean)
                .join(' · '),
            }))}
          />
        ) : null}
        {data.active === 'cases' ? (
          <List
            empty={t('empty.cases')}
            items={data.cases.map((k) => ({
              key: k.id,
              href: `/customers/${c.id}/cases/${k.id}`,
              attr: k.status,
              title: `${data.stages[k.stage] ?? k.stage} · ${t(`caseStatus.${k.status as 'open'}`)}`,
              line: `${t(`priority.${k.priority as 'normal'}`)} · ${t('caseInvoices', { n: k.invoices })} · ${money(k.amountOpen)}`,
            }))}
          />
        ) : null}
        {data.active === 'documents' ? (
          <div className="flex flex-col gap-3">
            {data.keys.includes('document.create') ? <GenerateDocument customerId={c.id} /> : null}
            <List
              empty={t('empty.documents')}
              items={data.documents.map((d) => ({
                key: d.id,
                href: `/customers/${c.id}/documents/${d.id}`,
                attr: d.kind,
                title: `${t(`documentKind.${d.kind}`)} v${d.version}`,
                line: `${d.createdAt.slice(0, 10)} · ${d.hasPdf ? 'PDF' : t('pdfPending')} · ${d.locale}${d.createdBy ? ` · ${d.createdBy}` : ''}`,
              }))}
            />
          </div>
        ) : null}
      </section>
    </Screen>
  );
}

function List({
  items,
  empty,
}: {
  items: { key: string; title: string; line: string; href?: string; attr?: string }[];
  empty: string;
}) {
  if (items.length === 0)
    return (
      <p className="rounded-lg border border-border bg-surface p-4 text-text-muted">{empty}</p>
    );
  return (
    <ul className="flex flex-col gap-2">
      {items.map((i) => {
        const body = (
          <>
            <span className="font-medium text-text">{i.title}</span>
            <span className="block text-sm text-text-muted">{i.line}</span>
          </>
        );
        return (
          <li
            key={i.key}
            data-row={i.attr}
            className="rounded-lg border border-border bg-surface p-3"
          >
            {i.href ? (
              <Link href={i.href} className="block hover:underline">
                {body}
              </Link>
            ) : (
              body
            )}
          </li>
        );
      })}
    </ul>
  );
}
