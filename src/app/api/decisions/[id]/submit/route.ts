import { NextResponse } from 'next/server';
import { z } from 'zod';
import { NotFoundError, withTenant } from '@/server/auth/with-tenant';
import { submitRuleProposal } from '@/server/decisions/service';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.uuid() });

// Maker (3.3, rules 11 and 19): a rule's proposal goes to a checker — legal handover through
// case.legal_handover (approval.create), any other decision through decision.approve
// (decision.create). The service checks the permission that matches the proposal.
export const POST = withTenant<{ id: string }>(async (_request, ctx, params) => {
  const parsed = paramsSchema.safeParse(params);
  if (!parsed.success) {
    await ctx.requirePermission('decision.create');
    throw new NotFoundError();
  }
  return NextResponse.json(await submitRuleProposal(ctx, parsed.data.id), { status: 202 });
});
