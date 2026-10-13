import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { ForbiddenState } from '@/components/admin/forbidden-state';
import { PageHeader } from '@/components/admin/page-header';
import { Screen } from '@/components/shell/screen';
import { PermissionDeniedError } from '@/server/auth/permissions';
import { withTenantPage } from '@/server/auth/with-tenant';
import { listReportDefinitions } from '@/server/reporting/service';

export const dynamic = 'force-dynamic';

const SECTIONS = ['system', 'mine', 'shared'] as const;

// Reports (6.2), mobile-compact: ready-made, own and shared reports — one click opens one,
// "New report" builds one in a few clicks.
export default async function ReportsPage() {
  let defs;
  try {
    defs = await withTenantPage((ctx) => listReportDefinitions(ctx));
  } catch (error) {
    if (error instanceof PermissionDeniedError) return <ForbiddenState />;
    throw error;
  }
  const t = await getTranslations('reports');
  const groups = {
    system: defs.filter((d) => d.isSystem),
    mine: defs.filter((d) => d.mine),
    shared: defs.filter((d) => !d.isSystem && !d.mine),
  };
  const nameOf = (d: (typeof defs)[number]) =>
    d.systemKey && t.has(`names.${d.systemKey}` as 'names.disputes')
      ? t(`names.${d.systemKey}` as 'names.disputes')
      : d.name;
  return (
    <Screen mobileClass="mobile-compact">
      <PageHeader title={t('list.title')} description={t('list.description')} />
      <Link
        href="/reports/new"
        className="mb-4 inline-flex min-h-11 items-center rounded-md bg-brand-green px-4 font-medium text-surface"
        data-report-new
      >
        {t('list.new')}
      </Link>
      {SECTIONS.map((s) =>
        s === 'shared' && groups.shared.length === 0 ? null : (
          <section key={s} className="mb-4" data-report-group={s}>
            <h2 className="mb-2 font-semibold text-brand-green">{t(`list.${s}`)}</h2>
            {groups[s].length === 0 ? (
              <p className="text-sm text-text-muted">{t('list.emptyMine')}</p>
            ) : (
              <ul className="grid gap-2 md:grid-cols-2 lg:grid-cols-3">
                {groups[s].map((d) => (
                  <li key={d.id}>
                    <Link
                      href={`/reports/${d.id}`}
                      className="flex min-h-11 flex-col rounded-lg border border-border bg-surface p-3 hover:bg-brand-purple-soft"
                      data-report-link={d.systemKey ?? d.id}
                    >
                      <span className="font-medium text-text">{nameOf(d)}</span>
                      <span className="text-xs text-text-muted">
                        {t(`datasets.${d.definition.dataset}`)} · {t(`visuals.${d.visual}`)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ),
      )}
    </Screen>
  );
}
