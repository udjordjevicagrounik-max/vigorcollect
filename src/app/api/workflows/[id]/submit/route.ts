import { NextResponse } from 'next/server';
import { z } from 'zod';
import { NotFoundError, withTenant } from '@/server/auth/with-tenant';
import { submitForPublish } from '@/server/workflows/service';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.uuid() });

// Maker: sends the draft to approval (approval_request workflow.publish); another person with
// settings.manage publishes it from Admin → Approvals.
export const POST = withTenant<{ id: string }>(async (_request, ctx, params) => {
  await ctx.requirePermission('settings.manage');
  const parsed = paramsSchema.safeParse(params);
  if (!parsed.success) throw new NotFoundError();
  return NextResponse.json(await submitForPublish(ctx, parsed.data.id), { status: 202 });
});
