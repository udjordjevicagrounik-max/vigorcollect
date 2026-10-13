import { NextResponse } from 'next/server';
import { getAuthBaseURL } from '@/server/auth/better-auth';
import { withTenant } from '@/server/auth/with-tenant';
import { getMasterKeyring } from '@/server/crypto/keyring';
import { createTenant, listTenants, newTenantSchema } from '@/server/platform/service';

export const dynamic = 'force-dynamic';

// Platform → Tenants (6.4): tenant #0 + platform.manage (checked again in the service).
export const GET = withTenant(async (_request, ctx) => {
  await ctx.requirePermission('platform.manage');
  return NextResponse.json(await listTenants(ctx));
});

export const POST = withTenant(async (request, ctx) => {
  await ctx.requirePermission('platform.manage');
  return NextResponse.json(
    await createTenant(ctx, newTenantSchema.parse(await request.json()), {
      keyring: getMasterKeyring(),
      baseURL: getAuthBaseURL(),
    }),
    { status: 201 },
  );
});
