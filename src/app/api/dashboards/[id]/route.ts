import { NextResponse } from 'next/server';
import { z } from 'zod';
import { NotFoundError, withTenant } from '@/server/auth/with-tenant';
import {
  dashboardUpdateSchema,
  deleteDashboard,
  updateDashboard,
} from '@/server/dashboards/service';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.uuid() });

// Rename / publish (team, tenant, role default) / delete an own dashboard (6.3).
export const PUT = withTenant<{ id: string }>(async (request, ctx, params) => {
  await ctx.requirePermission('customer.read');
  const parsed = paramsSchema.safeParse(params);
  if (!parsed.success) throw new NotFoundError();
  return NextResponse.json(
    await updateDashboard(ctx, parsed.data.id, dashboardUpdateSchema.parse(await request.json())),
  );
});

export const DELETE = withTenant<{ id: string }>(async (_request, ctx, params) => {
  await ctx.requirePermission('customer.read');
  const parsed = paramsSchema.safeParse(params);
  if (!parsed.success) throw new NotFoundError();
  return NextResponse.json(await deleteDashboard(ctx, parsed.data.id));
});
