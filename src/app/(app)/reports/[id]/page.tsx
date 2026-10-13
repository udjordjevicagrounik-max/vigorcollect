import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { z } from 'zod';
import { ForbiddenState } from '@/components/admin/forbidden-state';
import { PageHeader } from '@/components/admin/page-header';
import { ReportView } from '@/components/reports/report-view';
import { Screen } from '@/components/shell/screen';
import { PermissionDeniedError, permissionKeys } from '@/server/auth/permissions';
import { ConflictError, NotFoundError, withTenantPage } from '@/server/auth/with-tenant';
import { getReportDefinition, runSpec } from '@/server/reporting/service';

export const dynamic = 'force-dynamic';

// One report (6.2): visual, drill-down, export, copy / edit, add to dashboard.
export default async function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  const parsed = z.object({ id: z.uuid() }).safeParse(await params);
  if (!parsed.success) notFound();
  const locale = await getLocale();
  let data;
  try {
    data = await withTenantPage(async (ctx) => {
      const def = await getReportDefinition(ctx, parsed.data.id);
      let result;
      let error: string | null = null;
      try {
        result = await runSpec(ctx, def.definition, { locale });
      } catch (e) {
        if (!(e instanceof ConflictError)) throw e;
        error = e.code;
      }
      return {
        def,
        result,
        error,
        canExport: (await permissionKeys(ctx.db, ctx.userId)).has('report.export'),
      };
    });
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    if (error instanceof PermissionDeniedError) return <ForbiddenState />;
    throw error;
  }
  const t = await getTranslations('reports');
  const tErrors = await getTranslations('errors');
  const d = data.def;
  const title =
    d.systemKey && t.has(`names.${d.systemKey}` as 'names.disputes')
      ? t(`names.${d.systemKey}` as 'names.disputes')
      : d.name;
  const description =
    d.systemKey && t.has(`definitions.${d.systemKey}` as 'definitions.disputes')
      ? t(`definitions.${d.systemKey}` as 'definitions.disputes')
      : t(`datasets.${d.definition.dataset}`);
  return (
    <Screen mobileClass="mobile-compact">
      <PageHeader title={title} description={description} />
      {data.result ? (
        <ReportView
          id={d.id}
          definition={d.definition}
          visual={d.visual}
          data={data.result}
          mine={d.mine}
          isSystem={d.isSystem}
          canExport={data.canExport}
        />
      ) : (
        <p
          className="rounded-lg border border-border bg-surface p-4 text-sm text-text-muted"
          role="status"
        >
          {tErrors(data.error as 'mixed_currencies')}
        </p>
      )}
    </Screen>
  );
}
