import { NextResponse } from 'next/server';
import { withTenant } from '@/server/auth/with-tenant';
import {
  listReportDefinitions,
  reportSaveSchema,
  saveReportDefinition,
} from '@/server/reporting/service';

export const dynamic = 'force-dynamic';

// Report definitions visible to the member (system, own, team, tenant) — 6.2.
export const GET = withTenant(async (_request, ctx) => {
  await ctx.requirePermission('report.read');
  return NextResponse.json(await listReportDefinitions(ctx));
});

export const POST = withTenant(async (request, ctx) => {
  await ctx.requirePermission('report.read');
  return NextResponse.json(
    await saveReportDefinition(ctx, reportSaveSchema.parse(await request.json())),
    {
      status: 201,
    },
  );
});
