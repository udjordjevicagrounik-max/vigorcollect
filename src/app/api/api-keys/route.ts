import { NextResponse } from 'next/server';
import { withTenant } from '@/server/auth/with-tenant';
import { createApiKey, newApiKeySchema } from '@/server/integrations/api-keys';

export const dynamic = 'force-dynamic';

// A tenant API key (4.1). The token is in this answer ONCE — shown in the UI, never logged.
export const POST = withTenant(async (request, ctx) => {
  await ctx.requirePermission('integration.manage');
  const input = newApiKeySchema.parse(await request.json());
  return NextResponse.json(await createApiKey(ctx, input), { status: 201 });
});
