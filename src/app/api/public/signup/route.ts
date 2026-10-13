import { NextResponse, type NextRequest } from 'next/server';
import { apiError } from '@/lib/api-error';
import { REQUEST_ID_HEADER, resolveRequestId } from '@/lib/request-id';
import { getAuthAppPool } from '@/server/auth/better-auth';
import { sameOrigin } from '@/server/auth/with-tenant';
import { getMasterKeyring } from '@/server/crypto/keyring';
import { signup, signupSchema } from '@/server/platform/signup';
import { clientIp } from '@/server/security/client-ip';
import { turnstileFromEnv, verifyTurnstile } from '@/server/security/turnstile';

// PUBLIC route (docs/permissions.md "Javne rute", rule 27): sign up → a 7-day sandbox. Own origin,
// Turnstile + honeypot + rate limit per IP and per e-mail; ALWAYS the same 202 answer (nothing
// tells whether an address is known or a limit was hit).
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
  if (!sameOrigin(request.headers, new URL(process.env.BETTER_AUTH_URL ?? 'http://invalid').origin))
    return apiError(403, 'forbidden_origin', requestId);
  const parsed = signupSchema.safeParse(await request.json().catch(() => null));
  if (parsed.success) {
    const ip = clientIp(request.headers);
    await signup(getAuthAppPool(), parsed.data, {
      keyring: getMasterKeyring(),
      baseURL: process.env.BETTER_AUTH_URL ?? '',
      ip,
      verifyCaptcha: (token) => verifyTurnstile(turnstileFromEnv(), token, ip),
    });
  }
  const response = NextResponse.json({ ok: true }, { status: 202 });
  response.headers.set(REQUEST_ID_HEADER, requestId);
  response.headers.set('cache-control', 'no-store');
  return response;
}
