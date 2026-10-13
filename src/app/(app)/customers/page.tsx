import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { ForbiddenState } from '@/components/admin/forbidden-state';
import { PageHeader } from '@/components/admin/page-header';
import { SavedFilters } from '@/components/receivables/saved-filters';
import { RiskBadge } from '@/components/risk/risk-badge';
import { Screen } from '@/components/shell/screen';
import { formatAmount } from '@/lib/format-amount';
import { PermissionDeniedError } from '@/server/auth/permissions';
import { withTenantPage } from '@/server/auth/with-tenant';
import {
  customerListQuery,
  listReceivableCustomers,
  listSavedFilters,
} from '@/server/receivables/service';

export const dynamic = 'force-dynamic';

const ME = 'me' as const;
const STATUSES = ['active', 'inactive', 'blocked'] as const;

// Customers (task 2.3), mobile-compact: search (name / tax id / external id), filters, saved
// filters; cards on a phone, a table from md up. Scope through scopeFilter() in the service.
export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = Object.fromEntries(
    Object.entries(await searchParams).filter(
      (e): e is [string, string] => typeof e[1] === 'string' && e[1] !== '',
    ),
  );
  const parsed = customerListQuery.safeParse(raw);
  const query = parsed.success ? parsed.data : {};
  const locale = await getLocale();
  let data;
  try {
    data = await withTenantPage(async (ctx) => ({
      customers: await listReceivableCustomers(ctx, query),
      saved: await listSavedFilters(ctx),
    }));
  } catch (error) {
    if (error instanceof PermissionDeniedError) return <ForbiddenState />;
    throw error;
  }
  const t = await getTranslations('customers');
  const money = (v: string, c: string) => formatAmount(v, c, locale);
  return (
    <Screen mobileClass="mobile-compact">
      <PageHeader title={t('title')} description={t('description')} />
      <form
        method="get"
        className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 md:flex-row md:flex-wrap md:items-end"
        role="search"
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
          {t('status')}
          <select
            name="status"
            defaultValue={query.status ?? ''}
            className="min-h-11 rounded-md border border-border bg-surface px-3"
          >
            <option value="">{t('any')}</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`statuses.${s}`)}
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
        <label className="flex min-h-11 items-center gap-2 text-sm text-text">
          <input
            type="checkbox"
            name="owner"
            value={ME}
            defaultChecked={query.owner === 'me'}
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
      <SavedFilters current={query} saved={data.saved} />

      {data.customers.length === 0 ? (
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
          <ul className="mt-4 flex flex-col gap-2 md:hidden" data-customer-cards>
            {data.customers.map((c) => (
              <li key={c.id} data-customer-row={c.id}>
                <Link
                  href={`/customers/${c.id}`}
                  className="block rounded-lg border border-border bg-surface p-3 hover:bg-brand-purple-soft"
                >
                  <span className="font-medium text-text">
                    {c.displayName ?? t('naturalPerson')}
                  </span>
                  <span className="block text-sm text-text-muted">
                    {t('cardLine', {
                      exposure: money(c.exposure, c.currency),
                      overdue: money(c.overdue, c.currency),
                      days: c.oldestDaysOverdue,
                    })}
                  </span>
                  <span className="block text-xs text-text-muted">
                    {t(`statuses.${c.status as (typeof STATUSES)[number]}`)} ·{' '}
                    {c.ownerName ?? t('noOwner')} · <RiskBadge band={c.riskBand} />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          <div className="mt-4 hidden overflow-x-auto rounded-lg border border-border bg-surface md:block">
            <table className="w-full text-sm">
              <thead className="text-left text-text-muted">
                <tr>
                  <th className="p-3 font-medium">{t('columns.customer')}</th>
                  <th className="p-3 text-right font-medium">{t('columns.exposure')}</th>
                  <th className="p-3 text-right font-medium">{t('columns.overdue')}</th>
                  <th className="p-3 text-right font-medium">{t('columns.oldest')}</th>
                  <th className="p-3 font-medium">{t('columns.risk')}</th>
                  <th className="p-3 font-medium">{t('columns.status')}</th>
                  <th className="p-3 font-medium">{t('columns.owner')}</th>
                </tr>
              </thead>
              <tbody>
                {data.customers.map((c) => (
                  <tr key={c.id} className="border-t border-border">
                    <td className="p-3">
                      <Link
                        href={`/customers/${c.id}`}
                        className="font-medium text-brand-purple underline"
                      >
                        {c.displayName ?? t('naturalPerson')}
                      </Link>
                      {c.taxId ? (
                        <span className="block text-xs text-text-muted">{c.taxId}</span>
                      ) : null}
                    </td>
                    <td className="p-3 text-right">{money(c.exposure, c.currency)}</td>
                    <td className="p-3 text-right font-medium">{money(c.overdue, c.currency)}</td>
                    <td className="p-3 text-right">
                      {c.oldestDaysOverdue ? t('days', { n: c.oldestDaysOverdue }) : '—'}
                    </td>
                    <td className="p-3">
                      <RiskBadge band={c.riskBand} />
                    </td>
                    <td className="p-3">
                      {t(`statuses.${c.status as (typeof STATUSES)[number]}`)}
                    </td>
                    <td className="p-3">{c.ownerName ?? t('noOwner')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Screen>
  );
}
