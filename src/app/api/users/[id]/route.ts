import { NextResponse } from 'next/server';
import { z } from 'zod';
import { NotFoundError, withTenant } from '@/server/auth/with-tenant';

export const dynamic = 'force-dynamic';

// One member of the current tenant. Scope: ORGANIZATION sees every member, OWN/TEAM only
// themselves (TEAM = OWN until teams, 1.6). Not visible = 404 — for another tenant's id too.
export const GET = withTenant<{ id: string }>(async (_request, ctx, params) => {
  const { scope } = await ctx.requirePermission('user.read');
  const id = z.uuid().safeParse(params.id);
  if (!id.success) throw new NotFoundError();
  if (scope !== 'ORGANIZATION' && id.data !== ctx.userId) throw new NotFoundError();

  const { rows } = await ctx.db.query<{ id: string; display_name: string; status: string }>(
    'SELECT id, display_name, status FROM users WHERE id = $1',
    [id.data],
  );
  const user = rows[0];
  if (!user) throw new NotFoundError();
  const { rows: roles } = await ctx.db.query<{ key: string; scope: string }>(
    `SELECT r.key, ur.scope FROM user_roles ur JOIN roles r ON r.id = ur.role_id
     WHERE ur.user_id = $1 ORDER BY r.key`,
    [id.data],
  );
  return NextResponse.json({
    id: user.id,
    displayName: user.display_name,
    status: user.status,
    roles,
  });
});
