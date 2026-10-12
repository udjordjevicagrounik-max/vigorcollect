import * as Sentry from '@sentry/nextjs';
import { Pool } from 'pg';
import { logEvent } from '@/lib/log';
import { getAppVersion } from '@/lib/version';
import { scrubEvent, scrubText, sensitiveKeySet } from './scrub';

/**
 * Sentry for the app AND the worker (same image; task 1.7). Without SENTRY_DSN it is silently
 * off. release = X-App-Version; every event carries the request id tag when there is one; PII
 * is scrubbed in beforeSend through pii_field_registry (rule 20) — sendDefaultPii stays false,
 * no tracing, no session replay (server-side only).
 */

let enabled = false;
let keys = sensitiveKeySet();

export function isSentryEnabled(): boolean {
  return enabled;
}

/** Columns the registry marks above P0 (or conditionally) become sensitive keys. */
async function loadRegistryKeys(): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    const { rows } = await pool.query<{ column_name: string }>(
      `SELECT DISTINCT column_name FROM pii_field_registry
       WHERE pii_class <> 'P0' OR conditional_on IS NOT NULL`,
    );
    keys = sensitiveKeySet(rows.map((r) => r.column_name));
  } catch {
    logEvent('sentry.registry_unavailable', { level: 'warn' });
  } finally {
    await pool.end().catch(() => undefined);
  }
}

export function sentryBeforeSend<E extends Record<string, unknown>>(event: E): E {
  return scrubEvent(event, keys);
}

export async function initSentry(role: 'web' | 'worker'): Promise<void> {
  const dsn = process.env.SENTRY_DSN?.trim();
  if (!dsn || enabled) return;
  Sentry.init({
    dsn,
    release: getAppVersion(),
    environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    initialScope: { tags: { process_role: role } },
    beforeSend: (event) =>
      sentryBeforeSend(event as unknown as Record<string, unknown>) as unknown as typeof event,
    beforeBreadcrumb: (crumb) => {
      const safe = { ...crumb };
      delete safe.data;
      if (safe.message) safe.message = scrubText(safe.message);
      return safe;
    },
  });
  enabled = true;
  await loadRegistryKeys();
  logEvent('sentry.enabled', { role });
}

/** Reports an error with P0 tags only (ids, codes). No-op without SENTRY_DSN. */
export function reportError(
  error: unknown,
  tags: Record<string, string | null | undefined> = {},
): void {
  if (!enabled) return;
  Sentry.withScope((scope) => {
    for (const [k, v] of Object.entries(tags)) if (v) scope.setTag(k, v);
    Sentry.captureException(error);
  });
}

/** Next.js onRequestError → Sentry with the request id as tag. */
export function reportRequestError(
  error: unknown,
  request: { path: string; method: string; headers: Record<string, string | string[] | undefined> },
): void {
  if (!enabled) return;
  const requestId = request.headers['x-request-id'];
  reportError(error, {
    request_id: Array.isArray(requestId) ? requestId[0] : requestId,
    path: request.path.replace(/\/invite\/[^/]+/, '/invite/[token]'),
    method: request.method,
  });
}
