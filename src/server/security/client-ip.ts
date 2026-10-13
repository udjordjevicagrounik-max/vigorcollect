/**
 * The client's IP address (review S-07) — ONE place for the rate limits, Turnstile and Better Auth.
 *
 * Every reverse proxy in front of the app APPENDS the address it saw to X-Forwarded-For; whatever
 * the client sent stays on the left. With TRUSTED_PROXY_HOPS proxies (default 1: nginx), the
 * client is therefore the entry `hops` positions from the right: XFF[len − hops]. Entries further
 * left are client-controlled and never used. A header shorter than `hops` did not pass through
 * all trusted proxies → no IP (the caller uses a shared "unknown" bucket).
 *
 * src/proxy.ts resolves it once per request and overwrites CLIENT_IP_HEADER, so a client that
 * sends its own x-client-ip is ignored; Better Auth reads only that header.
 */

export const CLIENT_IP_HEADER = 'x-client-ip';

type Env = Record<string, string | undefined>;

export function trustedProxyHops(env: Env = process.env): number {
  const raw = env.TRUSTED_PROXY_HOPS?.trim();
  if (!raw) return 1;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 10) {
    throw new Error('TRUSTED_PROXY_HOPS must be an integer 1..10');
  }
  return n;
}

const IPV4 = /^(\d{1,3})(\.\d{1,3}){3}$/;
const IPV6 = /^[0-9a-f:.]+$/i;

function plausibleIp(value: string): boolean {
  if (IPV4.test(value)) return value.split('.').every((p) => Number(p) <= 255);
  return value.includes(':') && IPV6.test(value) && value.length <= 45;
}

/** Client IP from X-Forwarded-For behind `hops` trusted proxies, or undefined. */
export function forwardedClientIp(
  headers: Headers,
  hops: number = trustedProxyHops(),
): string | undefined {
  const chain = (headers.get('x-forwarded-for') ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (chain.length < hops) return undefined;
  const ip = chain[chain.length - hops];
  return ip && plausibleIp(ip) ? ip : undefined;
}

/** For route handlers: the value src/proxy.ts resolved for this request. */
export function clientIp(headers: Headers): string | undefined {
  return headers.get(CLIENT_IP_HEADER) ?? undefined;
}
