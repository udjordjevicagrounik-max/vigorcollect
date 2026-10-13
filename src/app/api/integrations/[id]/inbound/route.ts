import { NextResponse, type NextRequest } from 'next/server';
import { apiError } from '@/lib/api-error';
import { APP_VERSION_HEADER, REQUEST_ID_HEADER, resolveRequestId } from '@/lib/request-id';
import { getAppVersion } from '@/lib/version';
import { getAuthAppPool } from '@/server/auth/better-auth';
import { getMasterKeyring } from '@/server/crypto/keyring';
import { receiveInbound } from '@/server/integrations/inbound';

export const dynamic = 'force-dynamic';

// Public route (docs/permissions.md "Javne rute"): n8n → us. No session; authenticity is the
// HMAC signature of the integration's secret + a fresh timestamp (src/server/integrations/
// inbound.ts). Rate limit per IP comes from the proxy. 202 = accepted, processed by the worker.
export async function POST(
  request: NextRequest,
  route: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
  const { id } = await route.params;
  const raw = await request.text();
  const result = await receiveInbound(
    getAuthAppPool(),
    getMasterKeyring(),
    id,
    raw,
    request.headers,
    requestId,
  );
  const response =
    'code' in result
      ? apiError(result.status, result.code, requestId)
      : NextResponse.json(
          result.status === 202 ? { accepted: true, id: result.eventId } : { duplicate: true },
          { status: result.status },
        );
  response.headers.set(REQUEST_ID_HEADER, requestId);
  response.headers.set(APP_VERSION_HEADER, getAppVersion());
  response.headers.set('cache-control', 'no-store');
  return response;
}
