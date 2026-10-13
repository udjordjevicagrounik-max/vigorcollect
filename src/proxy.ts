import { NextResponse, type NextRequest } from 'next/server';
import { apiErrorBody } from '@/lib/api-error';
import { getAppVersion } from '@/lib/version';
import { APP_VERSION_HEADER, REQUEST_ID_HEADER, resolveRequestId } from '@/lib/request-id';
import { contentSecurityPolicy, corsHeaders, securityHeaders } from '@/server/security/headers';
import { databaseRateLimiter, type RateLimiter } from '@/server/security/rate-limit';
import { CLIENT_IP_HEADER, forwardedClientIp } from '@/server/security/client-ip';

// Next 16 renamed `middleware.ts` to `proxy.ts` (same role). Every response carries
// X-Request-Id (correlation) and X-App-Version (rule 23) plus the security headers (1.4):
// nonce-based CSP, HSTS in production, X-Frame-Options DENY, Referrer-/Permissions-Policy.
// /api/* (except Better Auth's own /api/auth/*, which limits itself) is rate-limited per IP in
// the database; CORS answers only the app's own origin.

export const NONCE_HEADER = 'x-nonce';

function allowedOrigin(): string {
  try {
    return new URL(process.env.BETTER_AUTH_URL ?? '').origin;
  } catch {
    return '';
  }
}

function finish(response: NextResponse, requestId: string, csp: string): NextResponse {
  response.headers.set(REQUEST_ID_HEADER, requestId);
  response.headers.set(APP_VERSION_HEADER, getAppVersion());
  response.headers.set('Content-Security-Policy', csp);
  for (const [k, v] of Object.entries(
    securityHeaders({ production: process.env.NODE_ENV === 'production' }),
  )) {
    response.headers.set(k, v);
  }
  return response;
}

/** The proxy with an injectable limiter (tests); Next calls `proxy` below. */
export function createProxy(limiter: RateLimiter) {
  return async function handle(request: NextRequest): Promise<NextResponse> {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
    const csp = contentSecurityPolicy(nonce, { dev: process.env.NODE_ENV === 'development' });
    const path = request.nextUrl.pathname;
    // Resolved once from the trusted end of X-Forwarded-For (review S-07); never the client's own.
    const ip = forwardedClientIp(request.headers);

    // The worker process (PROCESS_ROLE=worker) serves nothing but its own /health.
    if (process.env.PROCESS_ROLE === 'worker' && path !== '/health') {
      return finish(new NextResponse(null, { status: 404 }), requestId, csp);
    }

    if (path.startsWith('/api/')) {
      const cors = corsHeaders(request.headers.get('origin'), allowedOrigin());
      if (request.method === 'OPTIONS') {
        const preflight = new NextResponse(null, { status: cors ? 204 : 403 });
        for (const [k, v] of Object.entries(cors ?? {})) preflight.headers.set(k, v);
        return finish(preflight, requestId, csp);
      }
      if (!path.startsWith('/api/auth/')) {
        const limit = await limiter(`api:${ip ?? 'unknown'}`);
        if (!limit.allowed) {
          const limited = NextResponse.json(apiErrorBody('rate_limited', requestId), {
            status: 429,
          });
          limited.headers.set('Retry-After', String(limit.retryAfter));
          return finish(limited, requestId, csp);
        }
      }
    }

    const requestHeaders = new Headers(request.headers);
    requestHeaders.set(REQUEST_ID_HEADER, requestId);
    if (ip) requestHeaders.set(CLIENT_IP_HEADER, ip);
    else requestHeaders.delete(CLIENT_IP_HEADER);
    // Next.js reads the nonce from the request's CSP header and puts it on its own scripts.
    requestHeaders.set('Content-Security-Policy', csp);
    requestHeaders.set(NONCE_HEADER, nonce);

    const response = NextResponse.next({ request: { headers: requestHeaders } });
    const cors = path.startsWith('/api/')
      ? corsHeaders(request.headers.get('origin'), allowedOrigin())
      : null;
    for (const [k, v] of Object.entries(cors ?? {})) response.headers.set(k, v);
    return finish(response, requestId, csp);
  };
}

export const proxy = createProxy(databaseRateLimiter);

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
