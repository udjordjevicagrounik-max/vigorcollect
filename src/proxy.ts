import { NextResponse, type NextRequest } from 'next/server';
import { getAppVersion } from '@/lib/version';
import { APP_VERSION_HEADER, REQUEST_ID_HEADER, resolveRequestId } from '@/lib/request-id';

// Next 16 renamed `middleware.ts` to `proxy.ts` (same role). Every response carries
// X-Request-Id (correlation) and X-App-Version (rule 23); handlers never set them.
export function proxy(request: NextRequest): NextResponse {
  const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));

  // The worker process (PROCESS_ROLE=worker) serves nothing but its own /health.
  if (process.env.PROCESS_ROLE === 'worker' && request.nextUrl.pathname !== '/health') {
    const notFound = new NextResponse(null, { status: 404 });
    notFound.headers.set(REQUEST_ID_HEADER, requestId);
    notFound.headers.set(APP_VERSION_HEADER, getAppVersion());
    return notFound;
  }

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(REQUEST_ID_HEADER, requestId);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set(REQUEST_ID_HEADER, requestId);
  response.headers.set(APP_VERSION_HEADER, getAppVersion());
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
