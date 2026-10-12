/**
 * Security headers (task 1.4). Applied by src/proxy.ts to every response.
 *
 * CSP: scripts only with the per-request nonce ('strict-dynamic' lets Next's own chunks load);
 * no 'unsafe-inline' for scripts or <style>. Exception: style ATTRIBUTES (style-src-attr), which
 * Next's route announcer and the Turnstile widget set and which cannot run code. Turnstile is the
 * only third party (script + iframe). Dev adds 'unsafe-eval' (React refresh) and ws: (HMR).
 * HSTS only in production. The app is never framed (X-Frame-Options DENY + frame-ancestors).
 */

export const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';

export function contentSecurityPolicy(nonce: string, options: { dev: boolean }): string {
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'script-src': ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'", TURNSTILE_ORIGIN],
    'style-src': ["'self'", `'nonce-${nonce}'`],
    'style-src-attr': ["'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'blob:'],
    'font-src': ["'self'"],
    'connect-src': ["'self'"],
    'frame-src': [TURNSTILE_ORIGIN],
    'frame-ancestors': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'object-src': ["'none'"],
    'manifest-src': ["'self'"],
    'worker-src': ["'self'"],
  };
  if (options.dev) {
    directives['script-src']?.push("'unsafe-eval'");
    directives['connect-src']?.push('ws:', 'wss:');
  }
  return Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(' ')}`)
    .join('; ');
}

export function securityHeaders(options: { production: boolean }): Record<string, string> {
  const headers: Record<string, string> = {
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    // Invitation and reset links carry one-time tokens in the path: never leak them.
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy':
      'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
  };
  if (options.production) {
    headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  }
  return headers;
}

/** CORS: only the app's own origin (BETTER_AUTH_URL) is ever allowed, with credentials. */
export function corsHeaders(
  origin: string | null,
  allowedOrigin: string,
): Record<string, string> | null {
  if (!origin || origin !== allowedOrigin) return null;
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, x-request-id, x-captcha-response',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}
