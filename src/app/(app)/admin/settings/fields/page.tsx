import { getLocale, getTranslations } from 'next-intl/server';
import { ForbiddenState } from '@/components/admin/forbidden-state';
import { PageHeader } from '@/components/admin/page-header';
import { CustomFieldsAdmin } from '@/components/custom-fields/fields-admin';
import { Screen } from '@/components/shell/screen';
import { PermissionDeniedError, permissionKeys } from '@/server/auth/permissions';
import { withTenantPage } from '@/server/auth/with-tenant';
import { listDefinitions } from '@/server/custom-fields/service';

export const dynamic = 'force-dynamic';

// Admin → Settings → Fields (6.1), mobile-compact.
export default async function FieldsPage() {
  const locale = await getLocale();
  let data;
  try {
    data = await withTenantPage(async (ctx) => {
      await ctx.requirePermission('settings.read');
      return {
        definitions: await listDefinitions(ctx, { includeArchived: true, locale }),
        canManage: (await permissionKeys(ctx.db, ctx.userId)).has('settings.manage'),
        max:
          (await ctx.db.query<{ n: number }>('SELECT custom_fields_max AS n FROM tenant_settings'))
            .rows[0]?.n ?? 30,
      };
    });
  } catch (error) {
    if (error instanceof PermissionDeniedError) return <ForbiddenState />;
    throw error;
  }
  const t = await getTranslations('customFields.admin');
  return (
    <Screen mobileClass="mobile-compact">
      <PageHeader title={t('title')} description={t('description')} />
      <CustomFieldsAdmin {...data} />
    </Screen>
  );
}
