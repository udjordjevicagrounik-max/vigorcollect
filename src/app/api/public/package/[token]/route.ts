import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { apiError } from '@/lib/api-error';
import { REQUEST_ID_HEADER, resolveRequestId } from '@/lib/request-id';
import { getAuthAppPool } from '@/server/auth/better-auth';
import { sameOrigin } from '@/server/auth/with-tenant';
import { getMasterKeyring } from '@/server/crypto/keyring';
import {
  answersSchema,
  fileSchema,
  savePackageAnswers,
  uploadPackageFile,
} from '@/server/platform/onboarding';
import { clientIp } from '@/server/security/client-ip';
import { turnstileFromEnv, verifyTurnstile } from '@/server/security/turnstile';

// PUBLIC route (docs/permissions.md "Javne rute", rule 27): the client's data package. The token
// (256 bit, hash only in the database, 72 h) is the authorization; own origin, Turnstile, rate
// limit per IP. A file goes to import_runs 'staged' (sealed); answers store codes only.
export const dynamic = 'force-dynamic';

const bodySchema = z.discriminatedUnion('kind', [
  fileSchema.extend({ kind: z.literal('file') }),
  answersSchema.extend({ kind: z.literal('answers') }),
]);

export async function POST(
  request: NextRequest,
  route: { params: Promise<{ token: string }> },
): Promise<NextResponse> {
  const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
  if (!sameOrigin(request.headers, new URL(process.env.BETTER_AUTH_URL ?? 'http://invalid').origin))
    return apiError(403, 'forbidden_origin', requestId);
  const { token } = await route.params;
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError(400, 'invalid', requestId);
  const ip = clientIp(request.headers);
  const deps = {
    keyring: getMasterKeyring(),
    ip,
    verifyCaptcha: (t: string | undefined) => verifyTurnstile(turnstileFromEnv(), t, ip),
  };
  const body =
    parsed.data.kind === 'file'
      ? { outcome: await uploadPackageFile(getAuthAppPool(), token, parsed.data, deps) }
      : await savePackageAnswers(getAuthAppPool(), token, parsed.data, deps);
  const response = NextResponse.json(body, { status: body.outcome === 'ok' ? 200 : 400 });
  response.headers.set(REQUEST_ID_HEADER, requestId);
  response.headers.set('cache-control', 'no-store');
  return response;
}
