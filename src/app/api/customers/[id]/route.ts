import { NextResponse } from 'next/server';
import { z } from 'zod';
import { NotFoundError, withTenant } from '@/server/auth/with-tenant';
import { getCustomer } from '@/server/customers/service';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.uuid() });

// One customer; outside the member's scope or tenant → 404 (never 403).
export const GET = withTenant<{ id: string }>(async (_request, ctx, params) => {
  await ctx.requirePermission('customer.read');
  const parsed = paramsSchema.safeParse(params);
  if (!parsed.success) throw new NotFoundError();
  return NextResponse.json(await getCustomer(ctx, parsed.data.id));
});
