import { NextResponse } from 'next/server';
import { getAuthBaseURL } from '@/server/auth/better-auth';
import { createInvitation, InvitationError } from '@/server/auth/invitations';
import { ConflictError, withTenant } from '@/server/auth/with-tenant';
import { getMasterKeyring } from '@/server/crypto/keyring';

export const dynamic = 'force-dynamic';

// Invite a person, or re-send (a new token; the pending one is revoked). Owner → any role,
// admin → any role but owner (ADR 0004). The token goes only into the e-mail (sink).
export const POST = withTenant(async (request, ctx) => {
  await ctx.requirePermission('user.create');
  try {
    const created = await createInvitation(
      ctx,
      { keyring: getMasterKeyring(), baseURL: getAuthBaseURL() },
      await request.json(),
    );
    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    if (error instanceof InvitationError) {
      if (error.code === 'forbidden_role') {
        return NextResponse.json({ error: 'forbidden' }, { status: 403 });
      }
      throw new ConflictError(error.code);
    }
    throw error;
  }
});
