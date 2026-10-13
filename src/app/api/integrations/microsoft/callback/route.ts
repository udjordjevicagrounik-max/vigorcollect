import { NextResponse, type NextRequest } from 'next/server';
import { getAuth, getAuthPool } from '@/server/auth/better-auth';
import { getAuthContext } from '@/server/auth/session';
import { ConflictError, NotFoundError, withTenant } from '@/server/auth/with-tenant';
import { getMasterKeyring } from '@/server/crypto/keyring';
import { callbackQuery, finishMicrosoft } from '@/server/integrations/mailbox';

export const dynamic = 'force-dynamic';

// Redirect back from Microsoft (5.3). The state must belong to this member AND this session
// (else 404); the code is exchanged with the PKCE verifier. Back to Admin → Integrations with
// a status only — nothing else in the URL.
const back = (outcome: string) =>
  NextResponse.redirect(
    new URL(`/admin/integrations?microsoft=${outcome}`, process.env.BETTER_AUTH_URL),
    303,
  );

export const GET = withTenant(async (request: NextRequest, ctx) => {
  await ctx.requirePermission('integration.manage');
  const query = callbackQuery.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  const auth = await getAuthContext(getAuth(), getAuthPool(), request.headers);
  if (!query.success || auth.status !== 'ok') return back('failed');
  try {
    return back(await finishMicrosoft(ctx, auth.sessionId, query.data, getMasterKeyring()));
  } catch (error) {
    // A wrong / foreign / reused state or a failed exchange: the state stays used, nothing stored.
    if (error instanceof NotFoundError || error instanceof ConflictError) return back('failed');
    throw error;
  }
});
