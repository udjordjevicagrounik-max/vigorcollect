import { NextResponse } from 'next/server';
import { withTenant } from '@/server/auth/with-tenant';
import { listSavedFilters, saveFilter, savedFilterSchema } from '@/server/receivables/service';

export const dynamic = 'force-dynamic';

// Saved customer-list filters of the signed-in member (private, task 2.3).
export const GET = withTenant(async (_request, ctx) => {
  await ctx.requirePermission('customer.read');
  return NextResponse.json({ filters: await listSavedFilters(ctx) });
});

export const POST = withTenant(async (request, ctx) => {
  await ctx.requirePermission('customer.read');
  const input = savedFilterSchema.parse(await request.json());
  return NextResponse.json(await saveFilter(ctx, input), { status: 201 });
});
