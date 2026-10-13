import { NextResponse } from 'next/server';
import { withTenant } from '@/server/auth/with-tenant';
import { getPreferences, preferencesSchema, savePreferences } from '@/server/notifications/digest';

export const dynamic = 'force-dynamic';

// The signed-in member's own notification preferences (5.2) — nobody sets them for someone else.
export const GET = withTenant(async (_request, ctx) => {
  await ctx.requirePermission('customer.read');
  return NextResponse.json(await getPreferences(ctx));
});

export const PUT = withTenant(async (request, ctx) => {
  await ctx.requirePermission('customer.read');
  return NextResponse.json(
    await savePreferences(ctx, preferencesSchema.parse(await request.json())),
  );
});
