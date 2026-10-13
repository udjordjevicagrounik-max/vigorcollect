import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuth, createAuthPool } from '@/server/auth/better-auth';
import { closePools, migratePool } from './helpers';

// Golden (never delete or skip) — task 1.4, rule 27: Turnstile on sign-in, password reset and
// invitation acceptance; Better Auth's origin check (CSRF) on its own mutations. A local fake of
// Cloudflare's siteverify accepts exactly one token; nothing leaves the machine.

const BASE_URL = 'http://localhost:3000';
const GOOD = 'good-token';
let server: Server;
let verifyUrl = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    req.on('end', () => {
      // Cloudflare accepts form-encoded and JSON bodies; Better Auth sends JSON, our adapter a form.
      const response = raw.trim().startsWith('{')
        ? (JSON.parse(raw) as { response?: string }).response
        : new URLSearchParams(raw).get('response');
      const success = response === GOOD;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({ success, 'error-codes': success ? [] : ['invalid-input-response'] }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  verifyUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/siteverify`;
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.BETTER_AUTH_SECRET = randomBytes(32).toString('base64');
  process.env.BETTER_AUTH_URL = BASE_URL;
  process.env.TURNSTILE_SITE_KEY = 'golden-site-key';
  process.env.TURNSTILE_SECRET = 'golden-secret';
  process.env.TURNSTILE_VERIFY_URL = verifyUrl;
});

afterAll(async () => {
  await migratePool.query(`DELETE FROM auth."rateLimit" WHERE key LIKE '198.18.0.%'`);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closePools();
});

function authWithTurnstile() {
  return createAuth(
    {
      connectionString: '',
      secret: randomBytes(32).toString('base64'),
      baseURL: BASE_URL,
      issuer: 'Golden',
      turnstile: { siteKey: 'golden-site-key', secret: 'golden-secret', verifyUrl },
    },
    createAuthPool(process.env.TEST_DATABASE_URL ?? ''),
  );
}

async function call(
  auth: ReturnType<typeof authWithTurnstile>,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; code: string }> {
  const res = await auth.handler(
    new Request(`${BASE_URL}/api/auth${path}`, {
      method: 'POST',
      headers: {
        origin: BASE_URL,
        'x-client-ip': `198.18.0.${Math.floor(Math.random() * 250) + 1}`,
        'content-type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  );
  const json = (await res.json().catch(() => ({}))) as { code?: string };
  return { status: res.status, code: json.code ?? '' };
}

describe('golden/db: Turnstile through Better Auth’s captcha plugin', () => {
  const credentials = { email: 'nobody@captcha-golden.example.test', password: 'whatever-123456' };

  it('sign-in without a token is refused before the password is even looked at', async () => {
    const auth = authWithTurnstile();
    expect(await call(auth, '/sign-in/email', credentials)).toEqual({
      status: 400,
      code: 'MISSING_RESPONSE',
    });
    const bad = await call(auth, '/sign-in/email', credentials, { 'x-captcha-response': 'forged' });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(bad.code).toBe('VERIFICATION_FAILED');
  });

  it('with a valid token the normal answer follows (unknown account → generic 401)', async () => {
    const auth = authWithTurnstile();
    expect(
      (await call(auth, '/sign-in/email', credentials, { 'x-captcha-response': GOOD })).status,
    ).toBe(401);
  });

  it('password reset needs a token as well', async () => {
    const auth = authWithTurnstile();
    const body = { email: credentials.email, redirectTo: `${BASE_URL}/reset` };
    expect((await call(auth, '/request-password-reset', body)).code).toBe('MISSING_RESPONSE');
    expect(
      (await call(auth, '/request-password-reset', body, { 'x-captcha-response': GOOD })).status,
    ).toBe(200);
  });

  it('Better Auth rejects a mutation from a foreign origin (CSRF)', async () => {
    const auth = authWithTurnstile();
    const res = await call(auth, '/sign-in/email', credentials, {
      origin: 'https://evil.example',
      'x-captcha-response': GOOD,
    });
    expect(res.status).toBe(403);
  });
});

describe('golden/db: Turnstile and origin on the invitation route', () => {
  async function accept(body: unknown, origin = BASE_URL) {
    const { POST } = await import('@/app/api/invitations/accept/route');
    const res = await POST(
      new NextRequest(`${BASE_URL}/api/invitations/accept`, {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
    return { status: res.status, body: (await res.json()) as { code: string } };
  }
  const token = 'A'.repeat(43);

  it('no or forged token → captcha_failed; a valid token reaches the invitation check', async () => {
    expect(await accept({ token, password: 'x'.repeat(16) })).toMatchObject({
      status: 400,
      body: { code: 'captcha_failed' },
    });
    expect(
      await accept({ token, password: 'x'.repeat(16), turnstileToken: 'forged' }),
    ).toMatchObject({ body: { code: 'captcha_failed' } });
    expect(await accept({ token, password: 'x'.repeat(16), turnstileToken: GOOD })).toMatchObject({
      status: 400,
      body: { code: 'invalid' },
    });
  });

  it('a foreign origin is refused before anything else', async () => {
    expect(await accept({ token, turnstileToken: GOOD }, 'https://evil.example')).toMatchObject({
      status: 403,
      body: { code: 'forbidden_origin' },
    });
  });
});
