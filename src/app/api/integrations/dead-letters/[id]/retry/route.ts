import { NextResponse } from 'next/server';
import { z } from 'zod';
import { NotFoundError, withTenant } from '@/server/auth/with-tenant';
import { retryDeadLetter, retrySchema } from '@/server/integrations/service';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.uuid() });

// Dead letter "retry" (rule 95): an inbound event is processed again, a delivery is re-queued.
export const POST = withTenant<{ id: string }>(async (request, ctx, params) => {
  await ctx.requirePermission('integration.manage');
  const parsed = paramsSchema.safeParse(params);
  if (!parsed.success) throw new NotFoundError();
  const input = retrySchema.parse(await request.json());
  return NextResponse.json(await retryDeadLetter(ctx, parsed.data.id, input), { status: 202 });
});
