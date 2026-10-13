import { NextResponse } from 'next/server';
import { withTenant } from '@/server/auth/with-tenant';
import { requestDailyRun } from '@/server/settings/daily-run';

export const dynamic = 'force-dynamic';

// Admin → System status (3.3): run today's daily job (promises, overdue events, rule triggers)
// now instead of after local 06:00. settings.manage, audited; the worker runs it idempotently.
export const POST = withTenant(async (_request, ctx) => {
  await ctx.requirePermission('settings.manage');
  return NextResponse.json(await requestDailyRun(ctx), { status: 202 });
});
