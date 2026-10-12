import { NextResponse } from 'next/server';
import { z } from 'zod';
import { NotFoundError, withTenant } from '@/server/auth/with-tenant';
import { handoverSchema, requestLegalHandover } from '@/server/collections/service';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.uuid() });

// "Hand over to legal" → approval_request case.legal_handover (rules 11, 19); the stage changes
// only when another person with approval.legal_handover approves.
export const POST = withTenant<{ id: string }>(async (request, ctx, params) => {
  await ctx.requirePermission('approval.create');
  const parsed = paramsSchema.safeParse(params);
  if (!parsed.success) throw new NotFoundError();
  const input = handoverSchema.parse(await request.json());
  return NextResponse.json(await requestLegalHandover(ctx, parsed.data.id, input), { status: 202 });
});
