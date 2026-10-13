import { NextResponse } from 'next/server';
import { z } from 'zod';
import { NotFoundError, withTenant } from '@/server/auth/with-tenant';
import { copyDashboard } from '@/server/dashboards/service';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.uuid() });

// Copies a dashboard (e.g. the system one) into a personal one, made the member's home.
export const POST = withTenant<{ id: string }>(async (_request, ctx, params) => {
  await ctx.requirePermission('customer.read');
  const parsed = paramsSchema.safeParse(params);
  if (!parsed.success) throw new NotFoundError();
  return NextResponse.json(await copyDashboard(ctx, parsed.data.id), { status: 201 });
});
