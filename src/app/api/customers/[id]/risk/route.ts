import { NextResponse } from 'next/server';
import { z } from 'zod';
import { NotFoundError, withTenant } from '@/server/auth/with-tenant';
import { refreshRisk } from '@/server/risk/service';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.uuid() });

// Customer 360 → Risk (4.3): recompute now (providers only where the cache expired). A changed
// band becomes a proposal, never a credit status change (rules 11, 19).
export const POST = withTenant<{ id: string }>(async (_request, ctx, params) => {
  await ctx.requirePermission('customer.update');
  const parsed = paramsSchema.safeParse(params);
  if (!parsed.success) throw new NotFoundError();
  return NextResponse.json(await refreshRisk(ctx, parsed.data.id));
});
