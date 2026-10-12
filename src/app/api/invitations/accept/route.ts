import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { getAuth, getAuthAppPool, honeypotFilled } from '@/server/auth/better-auth';
import { acceptInvitation, InvitationError } from '@/server/auth/invitations';

// PUBLIC route (docs/permissions.md, "Javne rute"): the invitee has no tenant session yet. The
// token itself is the authorization (256-bit, single use, 72 h). Answers carry only an error
// code — never whether an e-mail or account exists.
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  password: z.string().max(256).optional(),
  website: z.string().optional(),
});

function fail(code: string, status: number): NextResponse {
  return NextResponse.json({ error: code }, { status, headers: { 'cache-control': 'no-store' } });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail('invalid', 400);
  if (honeypotFilled(parsed.data)) return fail('invalid', 400);

  const auth = getAuth();
  try {
    if (parsed.data.password !== undefined) {
      await acceptInvitation(getAuthAppPool(), auth, parsed.data.token, {
        mode: 'new',
        password: parsed.data.password,
      });
    } else {
      // Existing person: the identity comes ONLY from the verified session cookie.
      const session = await auth.api.getSession({ headers: request.headers });
      if (!session) return fail('sign_in_required', 401);
      await acceptInvitation(getAuthAppPool(), auth, parsed.data.token, {
        mode: 'existing',
        authUserId: session.user.id,
      });
    }
    return NextResponse.json({ ok: true }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    if (error instanceof InvitationError) {
      return fail(error.code, error.code === 'weak_password' ? 422 : 400);
    }
    throw error;
  }
}
