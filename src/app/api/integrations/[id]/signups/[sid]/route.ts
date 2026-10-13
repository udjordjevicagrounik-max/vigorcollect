import { NextResponse, type NextRequest } from 'next/server';
import { apiError } from '@/lib/api-error';
import { REQUEST_ID_HEADER, resolveRequestId } from '@/lib/request-id';
import { getAuthAppPool } from '@/server/auth/better-auth';
import { getMasterKeyring } from '@/server/crypto/keyring';
import { readLead } from '@/server/platform/lead';

export const dynamic = 'force-dynamic';

// Public route (n8n → us), 6.4: the lead of a public signup for Pipedrive. No session: the HMAC
// of the operator's integration over "<t>.GET <path>" (src/server/platform/lead.ts).
export async function GET(
  request: NextRequest,
  route: { params: Promise<{ id: string; sid: string }> },
): Promise<Response> {
  const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
  const { id, sid } = await route.params;
  const result = await readLead(
    getAuthAppPool(),
    getMasterKeyring(),
    id,
    sid,
    request.nextUrl.pathname,
    request.headers,
  );
  const response =
    result.status === 200
      ? NextResponse.json(result.lead)
      : apiError(result.status, result.status === 404 ? 'not_found' : 'unauthorized', requestId);
  response.headers.set(REQUEST_ID_HEADER, requestId);
  response.headers.set('cache-control', 'no-store');
  return response;
}
