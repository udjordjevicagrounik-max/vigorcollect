import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { z } from 'zod';
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

// Edit an own report (6.2); a system or someone else's report is copied instead (404 here).
export default async function EditReportPage({ params }: { params: Promise<{ id: string }> }) {
  const parsed = z.object({ id: z.uuid() }).safeParse(await params);
  if (!parsed.success) notFound();
  const locale = await getLocale();
  let data;
  try {
    data = await withTenantPage(async (ctx) => {
      const def = await getReportDefinition(ctx, parsed.data.id);
      if (!def.mine) throw new NotFoundError();
      const keys = await permissionKeys(ctx.db, ctx.userId);
      return {
        def,
        catalog: await builderCatalog(ctx, locale),
        teams: keys.has('team.read')
          ? (await listTeams(ctx))
              .filter((x) => x.status === 'active')
              .map((x) => ({ id: x.id, name: x.name }))
          : [],
        canPublish: keys.has('report.export'),
      };
    });
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    if (error instanceof PermissionDeniedError) return <ForbiddenState />;
    throw error;
  }
  const t = await getTranslations('reports');
  return (
    <Screen mobileClass="mobile-compact">
      <PageHeader title={t('builder.editTitle')} description={t('builder.description')} />
      <ReportBuilder
        catalog={data.catalog}
        reportId={data.def.id}
        teams={data.teams}
        canPublish={data.canPublish}
        initial={{
          name: data.def.name,
          definition: data.def.definition as never,
          visual: data.def.visual,
          visibility: data.def.visibility as 'private',
        }}
      />
    </Screen>
  );
}
