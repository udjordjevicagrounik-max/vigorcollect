import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Webhook signatures (task 4.1), both directions, one format:
 *
 *   X-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
 *
 * Inbound: the timestamp must be within ±5 minutes (replay protection) and the MAC must match
 * (constant-time compare). The same raw bytes that were signed are verified — never a re-encoded
 * JSON. The secret is 32 random bytes, base64url, shown once when the integration is created.
 */

export const SIGNATURE_HEADER = 'x-signature';
export const TOLERANCE_SECONDS = 300;

export function newSecret(): string {
  return randomBytes(32).toString('base64url');
}

export function mac(secret: string, timestamp: number, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

export function signatureHeader(secret: string, rawBody: string, now: Date = new Date()): string {
  const t = Math.floor(now.getTime() / 1000);
  return `t=${t},v1=${mac(secret, t, rawBody)}`;
}

export type VerifyResult = 'ok' | 'missing' | 'malformed' | 'stale' | 'mismatch';

export function verifySignature(
  header: string | null,
  rawBody: string,
  secret: string,
  now: Date = new Date(),
): VerifyResult {
  if (!header) return 'missing';
  const parts = Object.fromEntries(
    header.split(',').map((p) => {
      const i = p.indexOf('=');
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    }),
  );
  const t = Number(parts.t);
  const v1 = parts.v1 ?? '';
  if (!Number.isInteger(t) || !/^[0-9a-f]{64}$/.test(v1)) return 'malformed';
  if (Math.abs(Math.floor(now.getTime() / 1000) - t) > TOLERANCE_SECONDS) return 'stale';
  const expected = Buffer.from(mac(secret, t, rawBody), 'hex');
  return timingSafeEqual(expected, Buffer.from(v1, 'hex')) ? 'ok' : 'mismatch';
}
