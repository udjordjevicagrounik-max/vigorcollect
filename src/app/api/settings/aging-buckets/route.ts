import { NextResponse } from 'next/server';
import { withTenant } from '@/server/auth/with-tenant';
import { agingBoundsSchema, saveAgingBounds } from '@/server/settings/configuration';

export const dynamic = 'force-dynamic';

// Day bounds of the aging buckets (5.2): contiguous from 0, the last open-ended.
export const PUT = withTenant(async (request, ctx) => {
  await ctx.requirePermission('settings.manage');
  return NextResponse.json(
    await saveAgingBounds(ctx, agingBoundsSchema.parse(await request.json())),
  );
});
