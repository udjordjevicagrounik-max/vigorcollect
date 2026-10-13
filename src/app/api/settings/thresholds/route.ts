import { NextResponse } from 'next/server';
import { withTenant } from '@/server/auth/with-tenant';
import { saveThresholds, thresholdsSchema } from '@/server/settings/configuration';

export const dynamic = 'force-dynamic';

// Attention thresholds, risk weights / bands, default policy, bulk limit (5.2).
export const PUT = withTenant(async (request, ctx) => {
  await ctx.requirePermission('settings.manage');
  return NextResponse.json(await saveThresholds(ctx, thresholdsSchema.parse(await request.json())));
});
