import { NextResponse } from 'next/server';
import { withTenant } from '@/server/auth/with-tenant';
import { bulkRequestSchema, startBulk } from '@/server/bulk/service';

export const dynamic = 'force-dynamic';

// Confirms a bulk action (5.1): the run is queued for the worker → 202 + run id (report page).
// Permission per action is checked in the service (and again per item in the worker).
export const POST = withTenant(async (request, ctx) => {
  await ctx.requireAnyPermission(['customer.read', 'invoice.read']);
  return NextResponse.json(await startBulk(ctx, bulkRequestSchema.parse(await request.json())), {
    status: 202,
  });
});
