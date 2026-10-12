import { NextResponse } from 'next/server';
import { z } from 'zod';
import { NotFoundError, withTenant } from '@/server/auth/with-tenant';
import { decideRoleChange, decisionSchema } from '@/server/users/service';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.uuid() });

// Checker decision on a pending request. Supported now: role changes (user.assign, checker-only);
// business approvals (write-off, credit limit …) arrive with their flows.
export const POST = withTenant<{ id: string }>(async (request, ctx, params) => {
  await ctx.requirePermission('user.assign');
  const parsed = paramsSchema.safeParse(params);
  if (!parsed.success) throw new NotFoundError();
  const input = decisionSchema.parse(await request.json());
  return NextResponse.json(await decideRoleChange(ctx, parsed.data.id, input));
});
