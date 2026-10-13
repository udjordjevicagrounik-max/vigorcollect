import { getLocale } from 'next-intl/server';
import { listDefinitions } from '@/server/custom-fields/service';
import { permissionKeys } from '@/server/auth/permissions';
import type { TenantContext } from '@/server/auth/with-tenant';
import { listTeams } from '@/server/teams/service';
import { listMembers } from '@/server/users/service';

/** Users and teams for the editor's "assign" action — only what the member may already see. */
export async function editorLookups(ctx: TenantContext) {
  const keys = await permissionKeys(ctx.db, ctx.userId);
  const users = keys.has('user.read') ? await listMembers(ctx) : [];
  const teams = keys.has('team.read') ? await listTeams(ctx) : [];
  return {
    users: users
      .filter((u) => u.status === 'active')
      .map((u) => ({ id: u.id, name: u.displayName })),
    teams: teams.filter((x) => x.status === 'active').map((x) => ({ id: x.id, name: x.name })),
    // 6.1: P0 custom fields of customers, invoices and cases can be rule conditions.
    customFields: (await listDefinitions(ctx, { locale: await getLocale() }))
      .filter((d) => d.piiClass === 'P0' && d.entityType !== 'contact')
      .map((d) => ({ key: d.key, label: d.label, type: d.type })),
  };
}
