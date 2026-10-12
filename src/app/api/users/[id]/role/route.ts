import { NextResponse } from 'next/server';
import { z } from 'zod';
import { NotFoundError, withTenant } from '@/server/auth/with-tenant';
import { changeMemberRole, roleChangeSchema } from '@/server/users/service';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.uuid() });

// Role change. Owner/admin involved → 202 with an approval request (four eyes, rule 11).
export const POST = withTenant<{ id: string }>(async (request, ctx, params) => {
  await ctx.requirePermission('user.update');
  const parsed = paramsSchema.safeParse(params);
  if (!parsed.success) throw new NotFoundError();
  const input = roleChangeSchema.parse(await request.json());
  const result = await changeMemberRole(ctx, parsed.data.id, input);
  return NextResponse.json(result, { status: result.status === 'applied' ? 200 : 202 });
});
