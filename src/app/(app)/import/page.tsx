import { getTranslations } from 'next-intl/server';
import { ForbiddenState } from '@/components/admin/forbidden-state';
import { PageHeader } from '@/components/admin/page-header';
import { ImportHistory } from '@/components/import/import-history';
import { ImportWizard } from '@/components/import/import-wizard';
import { Screen } from '@/components/shell/screen';
import { PermissionDeniedError, permissionKeys } from '@/server/auth/permissions';
import { withTenantPage } from '@/server/auth/with-tenant';
import { listImports } from '@/server/imports/service';

export const dynamic = 'force-dynamic';

// Import of invoices (task 2.2), mobile-compact: wizard + history of runs.
export default async function ImportPage() {
  let data;
  try {
    data = await withTenantPage(async (ctx) => {
      await ctx.requireAnyPermission(['import.read', 'import.create']);
      const keys = await permissionKeys(ctx.db, ctx.userId);
      return {
        canCreate: keys.has('import.create'),
        runs: keys.has('import.read') ? await listImports(ctx) : [],
      };
    });
  } catch (error) {
    if (error instanceof PermissionDeniedError) return <ForbiddenState />;
    throw error;
  }
  const t = await getTranslations('importPage');
  return (
    <Screen mobileClass="mobile-compact">
      <PageHeader title={t('title')} description={t('description')} />
      {data.canCreate ? <ImportWizard canRollback={data.canCreate} /> : null}
      <ImportHistory runs={data.runs} />
    </Screen>
  );
}
