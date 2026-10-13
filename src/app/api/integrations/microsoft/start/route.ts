import { NextResponse } from 'next/server';
import { getAuth, getAuthPool } from '@/server/auth/better-auth';
import { getAuthContext } from '@/server/auth/session';
import { NotFoundError, withTenant } from '@/server/auth/with-tenant';
import { getMasterKeyring } from '@/server/crypto/keyring';
import { startMicrosoft } from '@/server/integrations/mailbox';

export const dynamic = 'force-dynamic';

// "Connect Microsoft 365" (5.3): POST (same origin) → the Microsoft consent URL. The state is
// bound to THIS session; the browser navigates there.
export const POST = withTenant(async (request, ctx) => {
  await ctx.requirePermission('integration.manage');
  const auth = await getAuthContext(getAuth(), getAuthPool(), request.headers);
  if (auth.status !== 'ok') throw new NotFoundError();
  return NextResponse.json(await startMicrosoft(ctx, auth.sessionId, getMasterKeyring()));
});
