import { getTranslations } from 'next-intl/server';
import { ForbiddenState } from '@/components/admin/forbidden-state';
import { PageHeader } from '@/components/admin/page-header';
import { UsersAdmin } from '@/components/admin/users-admin';
import { Screen } from '@/components/shell/screen';
import { PermissionDeniedError, permissionKeys } from '@/server/auth/permissions';
import { withTenantPage } from '@/server/auth/with-tenant';
import { assignableRoles, listMembers } from '@/server/users/service';

export const dynamic = 'force-dynamic';

// Admin → Users (wireframe docs/wireframes/admin-users.html). mobile-compact: on a phone the
// table becomes cards; every action stays reachable.
export default async function UsersPage() {
  let data;
  try {
    data = await withTenantPage(async (ctx) => {
      const members = await listMembers(ctx);
      const permissions = await permissionKeys(ctx.db, ctx.userId);
      return {
        members,
        roles: await assignableRoles(ctx),
        me: ctx.userId,
        canCreate: permissions.has('user.create'),
        canUpdate: permissions.has('user.update'),
        canAssign: permissions.has('user.assign'),
      };
    });
  } catch (error) {
    if (error instanceof PermissionDeniedError) return <ForbiddenState />;
    throw error;
  }
  const t = await getTranslations('admin.users');
  return (
    <Screen mobileClass="mobile-compact">
      <PageHeader title={t('title')} description={t('description')} />
      <UsersAdmin {...data} />
    </Screen>
  );
}
