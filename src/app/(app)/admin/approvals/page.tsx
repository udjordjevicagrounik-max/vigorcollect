import { getTranslations } from 'next-intl/server';
import { ApprovalsAdmin } from '@/components/admin/approvals-admin';
import { ForbiddenState } from '@/components/admin/forbidden-state';
import { PageHeader } from '@/components/admin/page-header';
import { Screen } from '@/components/shell/screen';
import { listPendingApprovals } from '@/server/approvals/service';
import { PermissionDeniedError, permissionKeys } from '@/server/auth/permissions';
import { withTenantPage } from '@/server/auth/with-tenant';

export const dynamic = 'force-dynamic';

// Admin → Approvals (rule 11). The requester never sees decision buttons on their own request.
export default async function ApprovalsPage() {
  let data;
  try {
    data = await withTenantPage(async (ctx) => {
      const pending = await listPendingApprovals(ctx);
      const canPropose = (await permissionKeys(ctx.db, ctx.userId)).has('approval.create');
      const roles = await ctx.db.query<{ key: string }>(
        `SELECT key FROM roles WHERE key <> 'owner' ORDER BY key`,
      );
      const perms = await ctx.db.query<{ key: string }>('SELECT key FROM permissions ORDER BY key');
      return {
        pending,
        canPropose,
        roles: roles.rows.map((r) => r.key),
        permissions: perms.rows.map((p) => p.key),
      };
    });
  } catch (error) {
    if (error instanceof PermissionDeniedError) return <ForbiddenState />;
    throw error;
  }
  const t = await getTranslations('admin.approvals');
  return (
    <Screen mobileClass="mobile-compact">
      <PageHeader title={t('title')} description={t('description')} />
      <ApprovalsAdmin {...data} />
    </Screen>
  );
}
