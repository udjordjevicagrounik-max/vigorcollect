import { NextResponse } from 'next/server';
import { z } from 'zod';
import { mayInvite } from '@/server/auth/invitations';
import { PermissionDeniedError } from '@/server/auth/permissions';
import { ConflictError, NotFoundError, withTenant } from '@/server/auth/with-tenant';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.uuid() });

// Revoke a pending invitation. The id comes from the URL; another tenant's id is invisible
// under RLS → 404 (never 403, which would confirm it exists).
export const POST = withTenant<{ id: string }>(async (_request, ctx, params) => {
  await ctx.requirePermission('user.create');
  const parsed = paramsSchema.safeParse(params);
  if (!parsed.success) throw new NotFoundError();
  const { id } = parsed.data;

  const { rows } = await ctx.db.query<{ status: string; role_key: string }>(
    'SELECT status, role_key FROM user_invitations WHERE id = $1 FOR UPDATE',
    [id],
  );
  const invitation = rows[0];
  if (!invitation) throw new NotFoundError();
  const { rows: roles } = await ctx.db.query<{ key: string }>(
    `SELECT r.key FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1`,
    [ctx.userId],
  );
  if (
    !mayInvite(
      roles.map((r) => r.key),
      invitation.role_key,
    )
  )
    throw new PermissionDeniedError();
  if (invitation.status !== 'pending') throw new ConflictError('not_pending');

  await ctx.db.query(
    `UPDATE user_invitations SET status = 'revoked', updated_by = $2 WHERE id = $1`,
    [id, ctx.userId],
  );
  await ctx.audit({
    action: 'user_invitation.revoked',
    entityType: 'user_invitations',
    entityId: id,
    before: { status: 'pending' },
    after: { status: 'revoked', reason: 'manual' },
  });
  return NextResponse.json({ ok: true });
});
