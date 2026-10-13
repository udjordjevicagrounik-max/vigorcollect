import { NextResponse } from 'next/server';
import { getAuthBaseURL } from '@/server/auth/better-auth';
import { createInvitation, InvitationError, newInvitationSchema } from '@/server/auth/invitations';
import { PermissionDeniedError } from '@/server/auth/permissions';
import { ConflictError, withTenant } from '@/server/auth/with-tenant';
import { getMasterKeyring } from '@/server/crypto/keyring';

export const dynamic = 'force-dynamic';

// Invite a person, or re-send (a new token; the pending one is revoked). Owner → any role,
// admin → any role but owner (ADR 0004). The token goes only into the e-mail (sink).
// Review S-06: a privileged role (owner/admin/cfo/collection_manager) → 202, the invitation is
// issued only after another administrator approves (Administration → Approvals).
export const POST = withTenant(async (request, ctx) => {
  await ctx.requirePermission('user.create');
  const input = newInvitationSchema.parse(await request.json());
  try {
    const created = await createInvitation(
      ctx,
      { keyring: getMasterKeyring(), baseURL: getAuthBaseURL() },
      input,
    );
    return NextResponse.json(created, { status: created.status === 'sent' ? 201 : 202 });
  } catch (error) {
    if (error instanceof InvitationError) {
      if (error.code === 'forbidden_role') throw new PermissionDeniedError();
      if (
        error.code === 'already_member' ||
        error.code === 'user_disabled' ||
        error.code === 'unknown_role'
      ) {
        throw new ConflictError(error.code);
      }
      throw new ConflictError('conflict');
    }
    throw error;
  }
});
