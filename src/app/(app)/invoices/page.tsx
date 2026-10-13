import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { ForbiddenState } from '@/components/admin/forbidden-state';
import { PageHeader } from '@/components/admin/page-header';
import { BulkBar } from '@/components/receivables/bulk-bar';
import { Screen } from '@/components/shell/screen';
import { formatAmount } from '@/lib/format-amount';
import { PermissionDeniedError } from '@/server/auth/permissions';
import { withTenantPage } from '@/server/auth/with-tenant';
import { bulkOptions } from '@/server/bulk/service';
import { codeLabels, invoiceListQuery, listOpenInvoices } from '@/server/receivables/service';

export const dynamic = 'force-dynamic';

const BULK_FORM = 'bulk-invoices';
const ENTITY = 'invoices' as const;
const DISPUTED = ['only', 'exclude'] as const;

// Open invoices across the customers in scope (5.1), mobile-compact: search by number or
// customer, overdue / disputed / bucket filters, selection for bulk actions. Disputed invoices
// stay in the list (and in aging), marked.
export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = Object.fromEntries(
    Object.entries(await searchParams).filter(
      (e): e is [string, string] => typeof e[1] === 'string' && e[1] !== '',
    ),
  );
  const parsed = invoiceListQuery.safeParse(raw);
  const query = parsed.success ? parsed.data : {};
  const locale = await getLocale();
  let data;
  try {
    data = await withTenantPage(async (ctx) => ({
      invoices: await listOpenInvoices(ctx, query),
      buckets: await codeLabels(ctx, 'aging_bucket', locale),
      bulk: await bulkOptions(ctx, 'invoices'),
      policies: await codeLabels(ctx, 'collection_policy', locale),
    }));
  } catch (error) {
    if (error instanceof PermissionDeniedError) return <ForbiddenState />;
    throw error;
  }
  const t = await getTranslations('invoices');
  const money = (v: string, c: string) => formatAmount(v, c, locale);
  return (
    <Screen mobileClass="mobile-compact">
      <PageHeader title={t('title')} description={t('description')} />
      <form
        method="get"
        role="search"
        className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 md:flex-row md:flex-wrap md:items-end"
      >
        <label className="flex flex-1 flex-col gap-1 text-sm font-medium text-text">
          {t('search')}
          <input
            name="q"
            type="search"
            defaultValue={query.q ?? ''}
            placeholder={t('searchPlaceholder')}
            className="min-h-11 rounded-md border border-border bg-surface px-3"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium text-text">
          {t('bucket')}
          <select
            name="bucket"
            defaultValue={query.bucket ?? ''}
            className="min-h-11 rounded-md border border-border bg-surface px-3"
          >
            <option value="">{t('any')}</option>
            {Object.entries(data.buckets).map(([code, label]) => (
              <option key={code} value={code}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium text-text">
          {t('disputed')}
          <select
            name="disputed"
            defaultValue={query.disputed ?? ''}
            className="min-h-11 rounded-md border border-border bg-surface px-3"
          >
            <option value="">{t('any')}</option>
            {DISPUTED.map((d) => (
              <option key={d} value={d}>
                {t(`disputedFilter.${d}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-h-11 items-center gap-2 text-sm text-text">
          <input
            type="checkbox"
            name="overdue"
            value="1"
            defaultChecked={query.overdue === '1'}
            className="size-5"
          />
          {t('onlyOverdue')}
        </label>
        <button
          type="submit"
          className="min-h-11 rounded-md bg-brand-green px-4 font-medium text-surface hover:bg-brand-green-deep"
        >
          {t('apply')}
        </button>
      </form>

      {data.invoices.length === 0 ? (
        <section className="mt-4 rounded-lg border border-border bg-surface p-6 text-center">
          <h2 className="font-semibold text-brand-green">{t('emptyTitle')}</h2>
          <p className="mx-auto mt-2 max-w-prose text-text-muted">{t('emptyDescription')}</p>
          <Link
            href="/import"
            className="mt-4 inline-flex min-h-11 items-center rounded-md bg-brand-green px-4 font-medium text-surface"
          >
            {t('emptyAction')}
          </Link>
        </section>
      ) : (
        <>
          <BulkBar
            entity={ENTITY}
            actions={data.bulk.actions}
            users={data.bulk.users}
            teams={data.bulk.teams}
            templates={data.bulk.templates}
            policies={Object.entries(data.policies).map(([id, label]) => ({ id, label }))}
          />
          <ul className="mt-4 flex flex-col gap-2" data-invoice-list>
            {data.invoices.map((i) => (
              <li
                key={i.id}
                data-invoice-row={i.id}
                data-disputed={i.isDisputed ? '1' : undefined}
                className="flex items-stretch gap-2 rounded-lg border border-border bg-surface p-3"
              >
                <label className="flex min-h-11 min-w-11 items-center justify-center">
                  <span className="sr-only">{t('select')}</span>
                  <input
                    type="checkbox"
                    name="ids"
                    value={i.id}
                    form={BULK_FORM}
                    className="size-5"
                  />
                </label>
                <div className="flex min-w-0 flex-1 flex-col gap-1 md:flex-row md:items-center md:gap-4">
                  <Link
                    href={`/customers/${i.customerId}?tab=invoices`}
                    className="font-medium text-brand-purple underline md:w-40"
                  >
                    {i.number}
                  </Link>
                  <span className="text-sm text-text md:flex-1">
                    {i.customerName ?? t('naturalPerson')}
                  </span>
                  <span className="text-sm text-text-muted md:w-48">
                    {t('due', { date: i.dueDate })}
                    {i.isOverdue ? ` · ${t('days', { n: i.daysOverdue })}` : ''}
                  </span>
                  <span className="text-sm font-medium text-text md:w-40 md:text-right">
                    {money(i.amountOpen, i.currency)}
                  </span>
                  {i.isDisputed ? (
                    <span className="w-fit rounded bg-status-warning-bg px-2 text-xs font-medium text-status-warning-fg">
                      {t('disputedMark')}
                    </span>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
          {data.invoices.length >= 500 ? (
            <p className="mt-2 text-sm text-text-muted">{t('truncated', { n: 500 })}</p>
          ) : null}
        </>
      )}
    </Screen>
  );
}
