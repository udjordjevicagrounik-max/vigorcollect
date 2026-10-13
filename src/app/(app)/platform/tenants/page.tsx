import { getTranslations } from 'next-intl/server';
import { ForbiddenState } from '@/components/admin/forbidden-state';
import { PageHeader } from '@/components/admin/page-header';
import { TenantsAdmin } from '@/components/platform/tenants-admin';
import { Screen } from '@/components/shell/screen';
import { PermissionDeniedError } from '@/server/auth/permissions';
import { withTenantPage } from '@/server/auth/with-tenant';
import { listTenants } from '@/server/platform/service';

export const dynamic = 'force-dynamic';

// Platform → Tenants (6.4), mobile-compact: tenant #0 only, never business data (rule 32).
export default async function PlatformTenantsPage() {
  let tenants;
  try {
    tenants = await withTenantPage((ctx) => listTenants(ctx));
  } catch (error) {
    if (error instanceof PermissionDeniedError) return <ForbiddenState />;
    throw error;
  }
  const t = await getTranslations('platform');
  return (
    <Screen mobileClass="mobile-compact">
      <PageHeader title={t('title')} description={t('description')} />
      <TenantsAdmin tenants={tenants} />
    </Screen>
  );
}
