import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { z } from 'zod';
import { ForbiddenState } from '@/components/admin/forbidden-state';
import { PageHeader } from '@/components/admin/page-header';
import { TenantDetail } from '@/components/platform/tenants-admin';
import { Screen } from '@/components/shell/screen';
import { PermissionDeniedError } from '@/server/auth/permissions';
import { withTenantPage } from '@/server/auth/with-tenant';
import { getTracker, listTenants, tenantFlags } from '@/server/platform/service';

export const dynamic = 'force-dynamic';

// One client tenant (6.4): lifecycle, implementation tracker (SLA 3 days), data package, flags.
export default async function PlatformTenantPage({ params }: { params: Promise<{ id: string }> }) {
  const parsed = z.object({ id: z.uuid() }).safeParse(await params);
  if (!parsed.success) notFound();
  let data;
  try {
    data = await withTenantPage(async (ctx) => {
      const tenant = (await listTenants(ctx)).find((x) => x.id === parsed.data.id);
      if (!tenant) return null;
      return {
        tenant,
        flags: await tenantFlags(ctx, tenant.id),
        tracker: await getTracker(ctx, tenant.id),
      };
    });
  } catch (error) {
    if (error instanceof PermissionDeniedError) return <ForbiddenState />;
    throw error;
  }
  if (!data) notFound();
  const t = await getTranslations('platform');
  return (
    <Screen mobileClass="mobile-compact">
      <PageHeader
        title={data.tenant.name}
        description={t('detailDescription', { slug: data.tenant.slug })}
      />
      <TenantDetail tenant={data.tenant} flags={data.flags} tracker={data.tracker} />
    </Screen>
  );
}
