import { NextResponse } from 'next/server';
import { z } from 'zod';
import { decideApproval } from '@/server/approvals/service';
import { NotFoundError, withTenant } from '@/server/auth/with-tenant';
import { decisionSchema } from '@/server/users/service';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.uuid() });

// Checker decision. The flow checks the checker permission of the request's type
// (user.assign for role changes, role.manage for grant changes, approval.legal_handover for a
// legal handover, settings.manage for a workflow publication) and requester ≠ decider.
export const POST = withTenant<{ id: string }>(async (request, ctx, params) => {
  await ctx.requireAnyPermission(['user.assign', 'role.manage', 'approval.legal_handover', 'settings.manage']);
  const parsed = paramsSchema.safeParse(params);
  if (!parsed.success) throw new NotFoundError();
  const input = decisionSchema.parse(await request.json());
  return NextResponse.json(await decideApproval(ctx, parsed.data.id, input));
});
