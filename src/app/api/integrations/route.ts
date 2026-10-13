import { NextResponse } from 'next/server';
import { withTenant } from '@/server/auth/with-tenant';
import { createIntegration, newIntegrationSchema } from '@/server/integrations/service';

export const dynamic = 'force-dynamic';

// Admin → Integrations (4.1): a new integration; the answer carries its signing secret ONCE.
export const POST = withTenant(async (request, ctx) => {
  await ctx.requirePermission('integration.manage');
  const input = newIntegrationSchema.parse(await request.json());
  return NextResponse.json(await createIntegration(ctx, input), { status: 201 });
});
