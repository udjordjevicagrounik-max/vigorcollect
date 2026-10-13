import { getTranslations } from 'next-intl/server';
import { ForbiddenState } from '@/components/admin/forbidden-state';
import { PageHeader } from '@/components/admin/page-header';
import { LibraryAdmin } from '@/components/library/library-admin';
import { Screen } from '@/components/shell/screen';
import { PermissionDeniedError, permissionKeys } from '@/server/auth/permissions';
import { withTenantPage } from '@/server/auth/with-tenant';

export const dynamic = 'force-dynamic';

// Admin → Settings → Libraries (6.4), mobile-compact.
export default async function LibraryPage() {
  let data;
  try {
    data = await withTenantPage(async (ctx) => {
      await ctx.requirePermission('settings.read');
      // The latest questionnaire of this tenant's data package proposes a policy template.
      const { rows } = await ctx.db.query<{
        proposal: 'friendly' | 'standard' | 'strict' | 'agro_seasonal';
      }>(
        `SELECT proposal FROM onboarding_packages WHERE proposal IS NOT NULL
         ORDER BY received_at DESC NULLS LAST, created_at DESC LIMIT 1`,
      );
      return {
        canManage: (await permissionKeys(ctx.db, ctx.userId)).has('settings.manage'),
        proposal: rows[0]?.proposal ?? null,
      };
    });
  } catch (error) {
    if (error instanceof PermissionDeniedError) return <ForbiddenState />;
    throw error;
  }
  const t = await getTranslations('library');
  return (
    <Screen mobileClass="mobile-compact">
      <PageHeader title={t('title')} description={t('description')} />
      <LibraryAdmin {...data} />
    </Screen>
  );
}
