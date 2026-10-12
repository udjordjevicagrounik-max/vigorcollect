import { NextResponse } from 'next/server';
import { withTenant } from '@/server/auth/with-tenant';
import { settingsSchema, updateTenantSettings } from '@/server/settings/service';

export const dynamic = 'force-dynamic';

// Tenant settings: language, time zone, currency, country (audit + domain event).
export const PUT = withTenant(async (request, ctx) => {
  await ctx.requirePermission('settings.manage');
  const input = settingsSchema.parse(await request.json());
  return NextResponse.json(await updateTenantSettings(ctx, input));
});
