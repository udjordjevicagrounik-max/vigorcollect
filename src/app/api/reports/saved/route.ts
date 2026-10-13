import { NextResponse } from 'next/server';
import { withTenant } from '@/server/auth/with-tenant';
import { saveReport, savedReportSchema } from '@/server/reports/service';

export const dynamic = 'force-dynamic';

// Saves a report's filters / columns / sort for the member (optionally shared in the tenant).
export const POST = withTenant(async (request, ctx) => {
  await ctx.requirePermission('report.read');
  return NextResponse.json(await saveReport(ctx, savedReportSchema.parse(await request.json())), {
    status: 201,
  });
});
