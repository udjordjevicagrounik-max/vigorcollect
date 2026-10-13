import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { apiError, type ApiErrorCode } from '@/lib/api-error';
import { logEvent } from '@/lib/log';
import { REQUEST_ID_HEADER, resolveRequestId } from '@/lib/request-id';
import { getAuth, getAuthAppPool, honeypotFilled } from '@/server/auth/better-auth';
import { acceptInvitation, InvitationError } from '@/server/auth/invitations';
import { sameOrigin } from '@/server/auth/with-tenant';
import { clientIp } from '@/server/security/client-ip';
import { turnstileFromEnv, verifyTurnstile } from '@/server/security/turnstile';

// PUBLIC route (docs/permissions.md, "Javne rute"): the invitee has no tenant session yet. The
// token itself is the authorization (256-bit, single use, 72 h). Turnstile + honeypot (rule 27),
// own origin only (CSRF). Answers carry only an error code — never whether an account exists.
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  password: z.string().max(256).optional(),
  website: z.string().max(256).optional(),
  turnstileToken: z.string().max(4096).optional(),
});

const STATUS: Partial<Record<ApiErrorCode, number>> = { weak_password: 422, sign_in_required: 401 };

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
  if (
    !sameOrigin(request.headers, new URL(process.env.BETTER_AUTH_URL ?? 'http://invalid').origin)
  ) {
    return apiError(403, 'forbidden_origin', requestId);
  }
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success || honeypotFilled(parsed.data)) return apiError(400, 'invalid', requestId);
  if (
    !(await verifyTurnstile(
      turnstileFromEnv(),
      parsed.data.turnstileToken,
      clientIp(request.headers),
    ))
  ) {
    return apiError(400, 'captcha_failed', requestId);
  }

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
      if (!session) return apiError(401, 'sign_in_required', requestId);
      await acceptInvitation(getAuthAppPool(), auth, parsed.data.token, {
        mode: 'existing',
        authUserId: session.user.id,
      });
    }
    return NextResponse.json({ ok: true }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    if (error instanceof InvitationError) {
      const code: ApiErrorCode = error.code === 'forbidden_role' ? 'forbidden' : error.code;
      return apiError(STATUS[code] ?? 400, code, requestId);
    }
    logEvent('error.unhandled', {
      level: 'error',
      requestId,
      name: error instanceof Error ? error.name : 'unknown',
    });
    return apiError(500, 'internal', requestId);
  }
}
