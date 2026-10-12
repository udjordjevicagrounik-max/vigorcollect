import { createHmac } from 'node:crypto';
import type { Auth } from '@/server/auth/better-auth';

// HTTP-level test client for Better Auth: real Request → auth.handler, with a cookie jar and a
// fixed client IP (x-forwarded-for), plus an RFC 6238 TOTP generator acting as the
// authenticator app. Test-side only; credentials are random per run and never printed.

export class AuthClient {
  private jar = new Map<string, string>();
  constructor(
    private readonly auth: Auth,
    private readonly baseURL: string,
    private readonly ip: string,
  ) {}

  async call(path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const headers = new Headers({ origin: this.baseURL, 'x-forwarded-for': this.ip });
    if (this.jar.size) {
      headers.set('cookie', [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '));
    }
    if (body !== undefined) headers.set('content-type', 'application/json');
    const res = await this.auth.handler(
      new Request(`${this.baseURL}/api/auth${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    for (const cookie of res.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const [name, ...value] = (pair ?? '').split('=');
      if (!name) continue;
      const v = value.join('=');
      if (v === '' || /max-age=0/i.test(cookie)) this.jar.delete(name);
      else this.jar.set(name, v);
    }
    const text = await res.text();
    return { status: res.status, json: text ? (JSON.parse(text) as unknown) : null };
  }

  headers(): Headers {
    return new Headers({ cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ') });
  }
}

function base32(secret: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secret.replace(/=+$/, '').toUpperCase()) {
    bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  }
  const bytes = bits.match(/.{8}/g) ?? [];
  return Buffer.from(bytes.map((b) => parseInt(b, 2)));
}

/** RFC 6238 (SHA-1, 6 digits, 30 s) from an otpauth:// URI. */
export function totp(otpauthUri: string, at = Date.now()): string {
  const secret = new URL(otpauthUri).searchParams.get('secret') ?? '';
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const h = createHmac('sha1', base32(secret)).update(counter).digest();
  const offset = (h[h.length - 1] ?? 0) & 0xf;
  const code = (h.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return code.toString().padStart(6, '0');
}
