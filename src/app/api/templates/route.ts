import { NextResponse } from 'next/server';
import { withTenant } from '@/server/auth/with-tenant';
import { listTemplates } from '@/server/templates/service';

export const dynamic = 'force-dynamic';

// Active templates with their texts per locale (task 3.2).
export const GET = withTenant(async (_request, ctx) => {
  await ctx.requirePermission('settings.read');
  return NextResponse.json({ templates: await listTemplates(ctx) });
});
