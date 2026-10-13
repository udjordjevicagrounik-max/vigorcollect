import { NextResponse } from 'next/server';
import { withTenant } from '@/server/auth/with-tenant';
import { drillForApi, drillSchema } from '@/server/reporting/service';

export const dynamic = 'force-dynamic';

// Drill-down (6.2): the entities behind one result row, within the member's scope.
export const POST = withTenant(async (request, ctx) => {
  await ctx.requirePermission('report.read');
  return NextResponse.json(await drillForApi(ctx, drillSchema.parse(await request.json())));
});
