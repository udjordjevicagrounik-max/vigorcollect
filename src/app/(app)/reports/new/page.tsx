import { getLocale, getTranslations } from 'next-intl/server';
import { ForbiddenState } from '@/components/admin/forbidden-state';
import { PageHeader } from '@/components/admin/page-header';
import { ReportBuilder } from '@/components/reports/report-builder';
import { Screen } from '@/components/shell/screen';
import { PermissionDeniedError, permissionKeys } from '@/server/auth/permissions';
import { NotFoundError, withTenantPage } from '@/server/auth/with-tenant';
import { builderCatalog } from '@/server/reporting/catalog';
import { getReportDefinition } from '@/server/reporting/service';
import { listTeams } from '@/server/teams/service';

export const dynamic = 'force-dynamic';

const DEFAULT_VISUAL = 'bar' as const;
const PRIVATE = 'private' as const;
const STARTER = {
  dataset: 'invoices',
  dimensions: [{ field: 'aging_bucket' }],
  measures: [{ field: 'open_amount', agg: 'sum' as const, fx: true }],
  filters: [{ field: 'is_open', op: 'eq', value: true }],
  sort: [],
  limit: 1000,
};

// New report (6.2) — empty start that already shows something, or a copy (?from=<id>).
export default async function NewReportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const from = (await searchParams).from;
  const locale = await getLocale();
  const t = await getTranslations('reports');
  let data;
  try {
    data = await withTenantPage(async (ctx) => {
      await ctx.requirePermission('report.read');
      const keys = await permissionKeys(ctx.db, ctx.userId);
      let copy = null;
      if (typeof from === 'string' && /^[0-9a-f-]{36}$/.test(from)) {
        try {
          copy = await getReportDefinition(ctx, from);
        } catch (e) {
          if (!(e instanceof NotFoundError)) throw e;
        }
      }
      return {
        catalog: await builderCatalog(ctx, locale),
        copy,
        teams: keys.has('team.read')
          ? (await listTeams(ctx))
              .filter((x) => x.status === 'active')
              .map((x) => ({ id: x.id, name: x.name }))
          : [],
        canPublish: keys.has('report.export'),
      };
    });
  } catch (error) {
    if (error instanceof PermissionDeniedError) return <ForbiddenState />;
    throw error;
  }
  const copyName = data.copy
    ? data.copy.systemKey && t.has(`names.${data.copy.systemKey}` as 'names.disputes')
      ? t(`names.${data.copy.systemKey}` as 'names.disputes')
      : data.copy.name
    : '';
  return (
    <Screen mobileClass="mobile-compact">
      <PageHeader title={t('builder.title')} description={t('builder.description')} />
      <ReportBuilder
        catalog={data.catalog}
        reportId={null}
        teams={data.teams}
        canPublish={data.canPublish}
        initial={{
          name: copyName,
          definition: (data.copy?.definition ?? STARTER) as never,
          visual: data.copy?.visual ?? DEFAULT_VISUAL,
          visibility: PRIVATE,
        }}
      />
    </Screen>
  );
}
