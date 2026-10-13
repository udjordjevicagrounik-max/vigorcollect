import { NextResponse } from 'next/server';
import { z } from 'zod';
import { NotFoundError, withTenant } from '@/server/auth/with-tenant';
import { disputeUpdateSchema, updateDispute } from '@/server/disputes/service';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.uuid() });

// Status (open → in_review → resolved_* / withdrawn, resolution note encrypted), owner
// (dispute.assign), expected date. A closed dispute is final.
export const PUT = withTenant<{ id: string }>(async (request, ctx, params) => {
  await ctx.requireAnyPermission(['dispute.update', 'dispute.assign']);
  const parsed = paramsSchema.safeParse(params);
  if (!parsed.success) throw new NotFoundError();
  const input = disputeUpdateSchema.parse(await request.json());
  return NextResponse.json(await updateDispute(ctx, parsed.data.id, input));
});
