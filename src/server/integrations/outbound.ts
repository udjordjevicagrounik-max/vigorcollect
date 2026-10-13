import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { logEvent } from '@/lib/log';
import type { MasterKeyring } from '@/server/crypto/keyring';
import { currentTenantId, type Queryable } from '@/server/crypto/subject-keys';
import type { TenantTx } from '@/server/jobs/tenant-job';
import { open } from './crypto';
import { SIGNATURE_HEADER, signatureHeader } from './signing';

/**
 * Outbound (task 4.1): an integration subscribes to domain events (config.events) and gets a
 * signed POST to its URL (config.outboundUrl — n8n's webhook) for each, with retry and backoff.
 * Payload = the domain event as stored: ids and P0 values only (pii_field_registry treats
 * domain_events.payload as such) — never names, addresses or mail bodies. A demo tenant never
 * sends outside the sink (rule 24): its deliveries are recorded as 'sink', not sent.
 *
 *   fan-out (worker handler of the event) → outbound_deliveries 'pending' (once per integration)
 *   dispatch (worker, every minute, per tenant) → POST → sent | failed (+backoff) | dead
 */

export const OUTBOUND_EVENT_TYPES = [
  'mail.queued',
  'mail.received',
  'mail.bounced',
  'mail.failed',
  'document.rendered',
  'promise.broken',
  'promise.fulfilled',
  'payment.received',
  'invoice.overdue',
  'case.opened',
  'case.stage_changed',
  'decision.submitted',
  'risk.band_changed',
  // 6.4: a public signup (tenant #0 only; payload ids — n8n fetches the lead with a signed GET).
  'signup.created',
] as const;

/** Seconds until the next attempt after attempt n (1-based); after the last one: dead. */
export const BACKOFF_SECONDS = [60, 300, 1_800, 7_200, 43_200] as const;
export const MAX_ATTEMPTS = BACKOFF_SECONDS.length + 1;
const TIMEOUT_MS = 10_000;
/** A claimed item is not picked up again before this; far longer than one POST (TIMEOUT_MS). */
export const CLAIM_LEASE_SECONDS = 600;
export const IDEMPOTENCY_HEADER = 'idempotency-key';

export type Fetch = (
  url: string,
  init: RequestInit,
) => Promise<{ status: number; text?: () => Promise<string> }>;

/**
 * Where we may POST. https only in production; never credentials in the URL; never a literal
 * private/loopback address or localhost in production (SSRF). Outside production http and
 * localhost are allowed (tests, a local n8n).
 */
export function validateOutboundUrl(
  value: string,
  production = process.env.NODE_ENV === 'production',
): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol !== 'https:' && (production || url.protocol !== 'http:')) return false;
  if (!production) return true;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal'))
    return false;
  if (isIP(host)) {
    if (/^(10\.|127\.|169\.254\.|192\.168\.|0\.)/.test(host)) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
    if (host === '::1' || /^f[cd]/i.test(host) || /^fe80/i.test(host)) return false;
  }
  return true;
}

/** Worker handler side: one pending delivery per subscribed active integration. */
export async function fanOut(
  db: Queryable,
  event: { id: string; eventType: string },
): Promise<number> {
  const { rowCount } = await db.query(
    `INSERT INTO outbound_deliveries (tenant_id, integration_id, event_id, event_type)
     SELECT app_tenant_id(), i.id, $1, $2 FROM integrations i
     WHERE i.status = 'active' AND i.config ? 'outboundUrl' AND (i.config->'events') ? $2
     ON CONFLICT DO NOTHING`,
    [event.id, event.eventType],
  );
  return rowCount ?? 0;
}

async function signingSecret(
  db: Queryable,
  keyring: MasterKeyring,
  tenantId: string,
  integrationId: string,
): Promise<string | null> {
  const { rows } = await db.query<{ id: string; secret_enc: Buffer; key_version: number }>(
    `SELECT id, secret_enc, secret_key_version AS key_version FROM integration_credentials
     WHERE integration_id = $1 AND purpose = 'signing' AND revoked_at IS NULL`,
    [integrationId],
  );
  const c = rows[0];
  return c
    ? open(keyring, tenantId, 'integration_credentials.secret', c.id, {
        ciphertext: c.secret_enc,
        keyVersion: c.key_version,
      })
    : null;
}

/** Where a signed POST goes: resolved INSIDE a tenant transaction, used outside of it. */
export type SignedTarget = { url: string; secret: string } | { error: 'invalid_url' | 'no_secret' };

export async function signedTarget(
  db: Queryable,
  keyring: MasterKeyring,
  integrationId: string,
): Promise<SignedTarget> {
  const tenantId = await currentTenantId(db);
  const { rows } = await db.query<{ url: string | null }>(
    `SELECT config->>'outboundUrl' AS url FROM integrations WHERE id = $1 AND status = 'active'`,
    [integrationId],
  );
  const url = rows[0]?.url;
  if (!url || !validateOutboundUrl(url)) return { error: 'invalid_url' };
  const secret = await signingSecret(db, keyring, tenantId, integrationId);
  if (!secret) return { error: 'no_secret' };
  return { url, secret };
}

export type SendResult = { status: number | null; error: string | null; body?: unknown };

/**
 * The POST itself — no database. `idempotencyKey` is stable across retries of the same item
 * (mail_outbox.id / outbound_deliveries.id), so the receiver can drop a repeat (review S-09).
 * Returns the HTTP status or an error code; never throws on the network.
 */
export async function sendSigned(
  target: SignedTarget,
  body: Record<string, unknown>,
  idempotencyKey: string,
  fetchImpl: Fetch = fetch,
  now: Date = new Date(),
): Promise<SendResult> {
  if ('error' in target) return { status: null, error: target.error };
  const raw = JSON.stringify(body);
  try {
    const res = await fetchImpl(target.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [SIGNATURE_HEADER]: signatureHeader(target.secret, raw, now),
        'x-event-id': String(body.id ?? ''),
        [IDEMPOTENCY_HEADER]: idempotencyKey,
      },
      body: raw,
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // The answer is untrusted too: read at most 64 KB, parse as JSON or ignore.
    let answer: unknown = null;
    try {
      const text = res.text ? (await res.text()).slice(0, 65_536) : '';
      answer = text ? (JSON.parse(text) as unknown) : null;
    } catch {
      answer = null;
    }
    return {
      status: res.status,
      error: res.status >= 200 && res.status < 300 ? null : `http_${res.status}`,
      body: answer,
    };
  } catch (error) {
    const name = error instanceof Error ? error.name : 'unknown';
    return { status: null, error: name === 'TimeoutError' ? 'timeout' : 'network' };
  }
}

/** Signed POST in one step — only for the test ping (nothing to retry, nothing to claim). */
export async function postSigned(
  db: Queryable,
  keyring: MasterKeyring,
  integrationId: string,
  body: Record<string, unknown>,
  fetchImpl: Fetch = fetch,
  now: Date = new Date(),
): Promise<SendResult> {
  const target = await signedTarget(db, keyring, integrationId);
  return sendSigned(target, body, String(body.id ?? ''), fetchImpl, now);
}

async function isDemoTenant(db: Queryable, tenantId: string): Promise<boolean> {
  const { rows } = await db.query<{ is_demo: boolean }>(
    'SELECT is_demo FROM tenants WHERE id = $1',
    [tenantId],
  );
  return rows[0]?.is_demo ?? true;
}

type Due = {
  id: string;
  integration_id: string;
  event_id: string | null;
  event_type: string;
  attempts: number;
  occurred_at: Date | null;
  aggregate_type: string | null;
  aggregate_id: string | null;
  payload: Record<string, unknown> | null;
};

/**
 * Delivers what is due for ONE tenant (review S-09). Every delivery is claimed in its own
 * committed transaction (next_attempt_at → end of the lease) BEFORE the POST, the POST runs
 * outside any transaction, and the result is recorded in a third one. An error in one delivery
 * never rolls back another one's "sent"; a crash after the POST retries only after the lease,
 * with the same Idempotency-Key.
 */
export async function dispatchDue(
  run: TenantTx,
  keyring: MasterKeyring,
  fetchImpl: Fetch = fetch,
  now: Date = new Date(),
): Promise<{ sent: number; failed: number; dead: number; sink: number }> {
  const leaseUntil = new Date(now.getTime() + CLAIM_LEASE_SECONDS * 1000);
  const { tenantId, demo, ids } = await run(async (db) => {
    const t = await currentTenantId(db);
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM outbound_deliveries
       WHERE status IN ('pending', 'failed') AND next_attempt_at <= $1
       ORDER BY next_attempt_at LIMIT 20`,
      [now],
    );
    return { tenantId: t, demo: await isDemoTenant(db, t), ids: rows.map((r) => r.id) };
  });
  const counts = { sent: 0, failed: 0, dead: 0, sink: 0 };
  for (const id of ids) {
    try {
      const claimed = await run(async (db) => {
        const { rows } = await db.query<Due>(
          `WITH claimed AS (
             UPDATE outbound_deliveries SET next_attempt_at = $3
             WHERE id = $1 AND status IN ('pending', 'failed') AND next_attempt_at <= $2
             RETURNING id, integration_id, event_id, event_type, attempts)
           SELECT c.*, e.created_at AS occurred_at, e.aggregate_type, e.aggregate_id, e.payload
           FROM claimed c LEFT JOIN domain_events e ON e.id = c.event_id`,
          [id, now, leaseUntil],
        );
        const d = rows[0];
        if (!d) return null;
        if (demo) {
          await db.query(`UPDATE outbound_deliveries SET status = 'sink' WHERE id = $1`, [d.id]);
          return 'sink' as const;
        }
        return { d, target: await signedTarget(db, keyring, d.integration_id) };
      });
      if (!claimed) continue;
      if (claimed === 'sink') {
        counts.sink += 1;
        continue;
      }
      const { d, target } = claimed;
      const body = {
        id: d.id,
        type: d.event_type,
        occurredAt: (d.occurred_at ?? now).toISOString(),
        data: {
          eventId: d.event_id,
          aggregateType: d.aggregate_type,
          aggregateId: d.aggregate_id,
          payload: d.payload ?? {},
        },
      };
      const result = await sendSigned(target, body, d.id, fetchImpl, now);
      const attempts = d.attempts + 1;
      if (!result.error) {
        await run((db) =>
          db.query(
            `UPDATE outbound_deliveries SET status = 'sent', sent_at = $2, attempts = $3, last_status_code = $4,
                    last_error = NULL WHERE id = $1`,
            [d.id, now, attempts, result.status],
          ),
        );
        counts.sent += 1;
        continue;
      }
      const dead =
        attempts >= MAX_ATTEMPTS || result.error === 'invalid_url' || result.status === 410;
      const delay = BACKOFF_SECONDS[Math.min(attempts, BACKOFF_SECONDS.length) - 1] ?? 60;
      await run((db) =>
        db.query(
          `UPDATE outbound_deliveries SET status = $2, attempts = $3, last_status_code = $4, last_error = $5,
                  next_attempt_at = $6 WHERE id = $1`,
          [
            d.id,
            dead ? 'dead' : 'failed',
            attempts,
            result.status,
            result.error,
            new Date(now.getTime() + delay * 1000),
          ],
        ),
      );
      counts[dead ? 'dead' : 'failed'] += 1;
    } catch (error) {
      // This delivery stays claimed until the lease ends; the others go on.
      logEvent('outbound.delivery_error', {
        level: 'error',
        tenantId,
        deliveryId: id,
        name: error instanceof Error ? error.name : 'unknown',
      });
    }
  }
  if (ids.length) logEvent('outbound.dispatched', { tenantId, ...counts });
  return counts;
}

/** Test ping from Admin → Integrations: one signed POST right now (sink for a demo tenant). */
export async function ping(
  db: Queryable,
  keyring: MasterKeyring,
  integrationId: string,
  fetchImpl: Fetch = fetch,
): Promise<{
  status: 'sent' | 'sink' | 'failed';
  httpStatus: number | null;
  error: string | null;
}> {
  const tenantId = await currentTenantId(db);
  const id = randomUUID();
  const demo = await isDemoTenant(db, tenantId);
  const result = demo
    ? { status: null, error: null }
    : await postSigned(
        db,
        keyring,
        integrationId,
        {
          id,
          type: 'integration.ping',
          occurredAt: new Date().toISOString(),
          data: {},
        },
        fetchImpl,
      );
  const status = demo ? 'sink' : result.error ? 'failed' : 'sent';
  await db.query(
    `INSERT INTO outbound_deliveries (id, tenant_id, integration_id, event_type, status, attempts, last_status_code,
                                      last_error, sent_at)
     VALUES ($1, app_tenant_id(), $2, 'integration.ping', $3, 1, $4, $5, CASE WHEN $3 = 'sent' THEN now() END)`,
    [id, integrationId, status === 'failed' ? 'dead' : status, result.status, result.error],
  );
  return { status, httpStatus: result.status, error: result.error };
}
