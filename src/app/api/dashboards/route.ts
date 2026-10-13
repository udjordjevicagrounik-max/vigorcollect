import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withTenant } from '@/server/auth/with-tenant';
import { createDashboard, listDashboards } from '@/server/dashboards/service';

export const dynamic = 'force-dynamic';

// Dashboards visible to the member (6.3); POST creates an empty personal one (made home).
export const GET = withTenant(async (_request, ctx) => {
  await ctx.requirePermission('customer.read');
  return NextResponse.json(await listDashboards(ctx));
});

export const POST = withTenant(async (request, ctx) => {
  await ctx.requirePermission('customer.read');
  const { name } = z
    .object({ name: z.string().trim().min(1).max(120) })
    .parse(await request.json());
  return NextResponse.json(await createDashboard(ctx, name), { status: 201 });
});
