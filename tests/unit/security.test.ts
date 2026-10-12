import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProxy } from '@/proxy';
import { sameOrigin } from '@/server/auth/with-tenant';
import { contentSecurityPolicy, corsHeaders, securityHeaders } from '@/server/security/headers';
import {
  assertTurnstileConfigured,
  TurnstileConfigError,
  turnstileFromEnv,
  verifyTurnstile,
} from '@/server/security/turnstile';

// Task 1.4: headers, CORS, CSRF origin rule, API rate limit and the Turnstile adapter.

const directive = (csp: string, name: string) =>
  csp.split('; ').find((d) => d.startsWith(`${name} `)) ?? '';

describe('Content-Security-Policy', () => {
  const csp = contentSecurityPolicy('abc123', { dev: false });

  it('scripts and <style> only with the nonce — no unsafe-inline / unsafe-eval in production', () => {
    expect(directive(csp, 'script-src')).toContain("'nonce-abc123'");
    expect(directive(csp, 'style-src')).toContain("'nonce-abc123'");
    expect(directive(csp, 'script-src')).not.toMatch(/unsafe-(inline|eval)/);
    expect(directive(csp, 'style-src')).not.toContain('unsafe-inline');
  });

  it('never framed; no plugins; base and form targets are our own', () => {
    expect(directive(csp, 'frame-ancestors')).toBe("frame-ancestors 'none'");
    expect(directive(csp, 'object-src')).toBe("object-src 'none'");
    expect(directive(csp, 'base-uri')).toBe("base-uri 'self'");
    expect(directive(csp, 'form-action')).toBe("form-action 'self'");
  });

  it('dev only adds unsafe-eval (React refresh) and ws: (HMR)', () => {
    const dev = contentSecurityPolicy('n', { dev: true });
    expect(directive(dev, 'script-src')).toContain("'unsafe-eval'");
    expect(directive(dev, 'connect-src')).toContain('ws:');
  });
});

describe('security headers', () => {
  it('HSTS only in production; framing denied; no referrer; powerful features off', () => {
    const prod = securityHeaders({ production: true });
    const dev = securityHeaders({ production: false });
    expect(prod['Strict-Transport-Security']).toMatch(/max-age=31536000/);
    expect(dev['Strict-Transport-Security']).toBeUndefined();
    expect(prod['X-Frame-Options']).toBe('DENY');
    expect(prod['Referrer-Policy']).toBe('no-referrer');
    expect(prod['Permissions-Policy']).toContain('camera=()');
    expect(prod['X-Content-Type-Options']).toBe('nosniff');
  });

  it('CORS answers only the exact app origin', () => {
    expect(corsHeaders('https://app.example.com', 'https://app.example.com')).toMatchObject({
      'Access-Control-Allow-Origin': 'https://app.example.com',
    });
    expect(corsHeaders('https://evil.example', 'https://app.example.com')).toBeNull();
    expect(
      corsHeaders('https://app.example.com.evil.example', 'https://app.example.com'),
    ).toBeNull();
    expect(corsHeaders(null, 'https://app.example.com')).toBeNull();
  });
});

describe('CSRF origin rule for mutations (withTenant)', () => {
  const allowed = 'https://app.example.com';
  it.each([
    [{ origin: 'https://app.example.com' }, true],
    [{ origin: 'https://evil.example' }, false],
    [{ origin: 'null' }, false],
    [{ 'sec-fetch-site': 'same-origin' }, true],
    [{ 'sec-fetch-site': 'cross-site' }, false],
    [{}, false],
  ])('%j → %s', (headers, ok) => {
    expect(sameOrigin(new Headers(headers as Record<string, string>), allowed)).toBe(ok);
  });
});

describe('proxy: API rate limit, CORS preflight, headers on every answer', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it('a limited IP gets 429 {code, message_key, request_id} with Retry-After; /api/auth is not counted', async () => {
    const limiter = vi.fn(async () => ({ allowed: false, retryAfter: 42 }));
    const handle = createProxy(limiter);
    const res = await handle(
      new NextRequest('http://localhost/api/users/x', {
        headers: { 'x-forwarded-for': '203.0.113.9' },
      }),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('42');
    expect(await res.json()).toMatchObject({
      code: 'rate_limited',
      message_key: 'errors.rate_limited',
    });
    expect(limiter).toHaveBeenCalledWith('api:203.0.113.9');

    limiter.mockClear();
    const auth = await handle(new NextRequest('http://localhost/api/auth/get-session'));
    expect(auth.status).toBe(200);
    expect(limiter).not.toHaveBeenCalled();
  });

  it('preflight: own origin 204 with CORS headers, any other origin 403 without them', async () => {
    process.env.BETTER_AUTH_URL = 'https://app.example.com';
    const handle = createProxy(async () => ({ allowed: true, retryAfter: 0 }));
    const own = await handle(
      new NextRequest('http://localhost/api/invitations', {
        method: 'OPTIONS',
        headers: { origin: 'https://app.example.com' },
      }),
    );
    const evil = await handle(
      new NextRequest('http://localhost/api/invitations', {
        method: 'OPTIONS',
        headers: { origin: 'https://evil.example' },
      }),
    );
    expect(own.status).toBe(204);
    expect(own.headers.get('access-control-allow-origin')).toBe('https://app.example.com');
    expect(evil.status).toBe(403);
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('every answer carries CSP with a fresh nonce, X-Frame-Options and the request id', async () => {
    const handle = createProxy(async () => ({ allowed: true, retryAfter: 0 }));
    const a = await handle(new NextRequest('http://localhost/login'));
    const b = await handle(new NextRequest('http://localhost/login'));
    const nonce = (r: Response) =>
      /'nonce-([^']+)'/.exec(r.headers.get('content-security-policy') ?? '')?.[1];
    expect(nonce(a)).toBeTruthy();
    expect(nonce(a)).not.toBe(nonce(b));
    expect(a.headers.get('x-frame-options')).toBe('DENY');
    expect(a.headers.get('x-request-id')).toBeTruthy();
  });
});

describe('Turnstile adapter (rule 27)', () => {
  const keys = { TURNSTILE_SITE_KEY: 'site', TURNSTILE_SECRET: 'secret' };

  it('both keys or none; production without keys refuses to start', () => {
    expect(turnstileFromEnv({})).toBeNull();
    expect(() => turnstileFromEnv({ TURNSTILE_SITE_KEY: 'x' })).toThrow(TurnstileConfigError);
    expect(() => assertTurnstileConfigured({ NODE_ENV: 'production' })).toThrow(
      TurnstileConfigError,
    );
    expect(() => assertTurnstileConfigured({ NODE_ENV: 'production', ...keys })).not.toThrow();
    expect(() => assertTurnstileConfigured({ NODE_ENV: 'development' })).not.toThrow();
  });

  it('without keys outside production verification is skipped (allowed)', async () => {
    expect(await verifyTurnstile(null, undefined, undefined)).toBe(true);
  });

  it('with keys: success only when Cloudflare says so; missing token or network error fails closed', async () => {
    const config = turnstileFromEnv(keys);
    const ok = vi.fn(async () => new Response(JSON.stringify({ success: true })));
    const no = vi.fn(async () => new Response(JSON.stringify({ success: false })));
    const down = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });
    expect(await verifyTurnstile(config, 'tok', '203.0.113.1', ok)).toBe(true);
    expect(await verifyTurnstile(config, 'tok', undefined, no)).toBe(false);
    expect(await verifyTurnstile(config, undefined, undefined, ok)).toBe(false);
    expect(await verifyTurnstile(config, 'tok', undefined, down)).toBe(false);
    const sent = ok.mock.calls[0] as unknown as [string, { body: URLSearchParams }];
    expect(sent[1].body.get('secret')).toBe('secret');
    expect(sent[1].body.get('remoteip')).toBe('203.0.113.1');
  });
});
