import { getTranslations } from 'next-intl/server';
import { ForbiddenState } from '@/components/admin/forbidden-state';
import { PageHeader } from '@/components/admin/page-header';
import { TeamsAdmin } from '@/components/admin/teams-admin';
import { Screen } from '@/components/shell/screen';
import { PermissionDeniedError, permissionKeys } from '@/server/auth/permissions';
import { withTenantPage } from '@/server/auth/with-tenant';
import { listTeams } from '@/server/teams/service';
import { listMembers } from '@/server/users/service';

export const dynamic = 'force-dynamic';

// Admin → Teams (task 1.6). mobile-compact: teams as cards; members and lead inside.
export default async function TeamsPage() {
  let data;
  try {
    data = await withTenantPage(async (ctx) => {
      const teams = await listTeams(ctx);
      const inTeam = new Set(teams.flatMap((t) => t.members.map((m) => m.userId)));
      const members = await listMembers(ctx);
      return {
        teams,
        free: members
          .filter((m) => m.status === 'active' && !inTeam.has(m.id))
          .map((m) => ({ id: m.id, displayName: m.displayName })),
        canManage: (await permissionKeys(ctx.db, ctx.userId)).has('user.update'),
      };
    });
  } catch (error) {
    if (error instanceof PermissionDeniedError) return <ForbiddenState />;
    throw error;
  }
  const t = await getTranslations('admin.teams');
  return (
    <Screen mobileClass="mobile-compact">
      <PageHeader title={t('title')} description={t('description')} />
      <TeamsAdmin {...data} />
    </Screen>
  );
}
