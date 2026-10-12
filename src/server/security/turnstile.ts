import { logEvent } from '@/lib/log';

/**
 * Cloudflare Turnstile (rule 27) — our adapter for routes outside Better Auth (invitation);
 * Better Auth's own endpoints (sign-in, password reset) use its official `captcha` plugin with
 * the same keys (src/server/auth/better-auth.ts).
 *
 *   - keys missing and NODE_ENV !== 'production' → verification is SKIPPED (logged once);
 *   - keys missing in production → the app refuses to start (assertTurnstileConfigured());
 *   - only one of the two keys → configuration error everywhere.
 * The secret is never logged or sent to the browser; the site key is public.
 */

export const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export type TurnstileConfig = { siteKey: string; secret: string; verifyUrl: string } | null;
type Env = Record<string, string | undefined>;

export class TurnstileConfigError extends Error {
  override name = 'TurnstileConfigError';
}

export function turnstileFromEnv(env: Env = process.env): TurnstileConfig {
  const siteKey = env.TURNSTILE_SITE_KEY?.trim();
  const secret = env.TURNSTILE_SECRET?.trim();
  if (!siteKey && !secret) return null;
  if (!siteKey || !secret) {
    throw new TurnstileConfigError('TURNSTILE_SITE_KEY and TURNSTILE_SECRET must be set together.');
  }
  return { siteKey, secret, verifyUrl: env.TURNSTILE_VERIFY_URL?.trim() || TURNSTILE_VERIFY_URL };
}

/** Startup guard: production without Turnstile keys does not start (docs/runbook.md). */
export function assertTurnstileConfigured(env: Env = process.env): void {
  const config = turnstileFromEnv(env);
  if (!config && env.NODE_ENV === 'production') {
    throw new TurnstileConfigError(
      'Turnstile keys are missing (TURNSTILE_SITE_KEY / TURNSTILE_SECRET) — refusing to start in production (rule 27).',
    );
  }
}

let skipLogged = false;

/** First address of X-Forwarded-For (set by the reverse proxy), else X-Real-IP. */
export function clientIp(headers: Headers): string | undefined {
  return (
    headers.get('x-forwarded-for')?.split(',')[0]?.trim() || headers.get('x-real-ip') || undefined
  );
}

export async function verifyTurnstile(
  config: TurnstileConfig,
  token: string | undefined,
  ip: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (!config) {
    if (process.env.NODE_ENV === 'production') return false; // fail closed (guard should have stopped us)
    if (!skipLogged) {
      logEvent('turnstile.skipped', { level: 'warn', reason: 'keys_missing_non_production' });
      skipLogged = true;
    }
    return true;
  }
  if (!token) return false;
  try {
    const body = new URLSearchParams({ secret: config.secret, response: token });
    if (ip) body.set('remoteip', ip);
    const res = await fetchImpl(config.verifyUrl, {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await res.json()) as { success?: boolean };
    return res.ok && data.success === true;
  } catch {
    logEvent('turnstile.unavailable', { level: 'error' });
    return false; // fail closed
  }
}
