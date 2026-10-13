import { NextResponse } from 'next/server';
import { getLocale } from 'next-intl/server';
import { withTenant } from '@/server/auth/with-tenant';
import { runForApi, runRequestSchema } from '@/server/reporting/service';

export const dynamic = 'force-dynamic';

// Runs a report definition (6.2) — POST: filter values may name customers, never in a URL.
export const POST = withTenant(async (request, ctx) => {
  await ctx.requirePermission('report.read');
  return NextResponse.json(
    await runForApi(ctx, runRequestSchema.parse(await request.json()), await getLocale()),
  );
});
