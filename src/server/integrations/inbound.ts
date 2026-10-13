import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import { logEvent } from '@/lib/log';
import type { MasterKeyring } from '@/server/crypto/keyring';
import { emitEvent } from '@/server/events';
import { open, seal } from './crypto';
import { SIGNATURE_HEADER, verifySignature } from './signing';

/**
 * Inbound webhook (task 4.1): POST /api/integrations/{id}/inbound — the only way n8n pushes data
 * to us. Public route (no session), so every step fails closed and looks the same from outside:
 *
 *   1. body ≤ 1 MB, JSON envelope {id, type, occurredAt?, data};
 *   2. the integration is found by id BEFORE the tenant is known (policy inbound_lookup: exactly
 *      that row) — unknown, disabled or without a secret → 401, like a bad signature;
 *   3. HMAC-SHA256 over "<t>.<raw body>" with the integration's secret, t within ±5 minutes
 *      (replay) → otherwise 401; nothing is stored for an unsigned request;
 *   4. inside the tenant: webhook_events row (encrypted body), exactly once per
 *      (integration, external id) — a repeat is 200 {duplicate: true}; a domain event hands the
 *      processing to the worker → 202 immediately.
 * The body is untrusted input (rule 22): it is data for its handler, never an instruction.
 */

export const MAX_BODY_BYTES = 1_000_000;

export const envelopeSchema = z.object({
  id: z.string().min(1).max(200),
  type: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/),
  occurredAt: z.iso.datetime({ offset: true }).optional(),
  data: z.record(z.string(), z.unknown()).default({}),
});

export type InboundResult =
  | { status: 202; eventId: string }
  | { status: 200; duplicate: true }
  | { status: 400 | 401 | 413; code: 'invalid_request' | 'unauthorized' | 'file_too_large' };

const UNAUTHORIZED = { status: 401, code: 'unauthorized' } as const;

export async function receiveInbound(
  pool: Pool,
  keyring: MasterKeyring,
  integrationId: string,
  rawBody: string,
  headers: Headers,
  requestId: string,
  now: Date = new Date(),
): Promise<InboundResult> {
  if (Buffer.byteLength(rawBody, 'utf8') > MAX_BODY_BYTES)
    return { status: 413, code: 'file_too_large' };
  if (!z.uuid().safeParse(integrationId).success) return UNAUTHORIZED;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('RESET app.tenant_id');
    await client.query("SELECT set_config('app.inbound_integration_id', $1, true)", [
      integrationId,
    ]);
    const found = await client.query<{ tenant_id: string; status: string }>(
      'SELECT tenant_id, status FROM integrations WHERE id = app_inbound_integration_id()',
    );
    const integration = found.rows[0];
    if (!integration || integration.status !== 'active') {
      await client.query('ROLLBACK');
      logEvent('webhook.rejected', { level: 'warn', reason: 'unknown_integration', requestId });
      return UNAUTHORIZED;
    }
    // From here on: the tenant of that integration only.
    await client.query('RESET app.inbound_integration_id');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [integration.tenant_id]);
    const cred = await client.query<{ id: string; secret_enc: Buffer; key_version: number }>(
      `SELECT id, secret_enc, secret_key_version AS key_version FROM integration_credentials
       WHERE integration_id = $1 AND purpose = 'signing' AND revoked_at IS NULL`,
      [integrationId],
    );
    const c = cred.rows[0];
    const secret = c
      ? open(keyring, integration.tenant_id, 'integration_credentials.secret', c.id, {
          ciphertext: c.secret_enc,
          keyVersion: c.key_version,
        })
      : null;
    const verdict = secret
      ? verifySignature(headers.get(SIGNATURE_HEADER), rawBody, secret, now)
      : 'missing';
    if (verdict !== 'ok') {
      await client.query('ROLLBACK');
      logEvent('webhook.rejected', {
        level: 'warn',
        reason: `signature_${verdict}`,
        tenantId: integration.tenant_id,
        integrationId,
        requestId,
      });
      return UNAUTHORIZED;
    }

    let envelope: z.infer<typeof envelopeSchema>;
    try {
      envelope = envelopeSchema.parse(JSON.parse(rawBody));
    } catch {
      await client.query('ROLLBACK');
      return { status: 400, code: 'invalid_request' };
    }

    const id = randomUUID();
    const sealed = seal(keyring, integration.tenant_id, 'webhook_events.body', id, rawBody);
    const ins = await client.query<{ id: string }>(
      `INSERT INTO webhook_events (id, tenant_id, integration_id, external_event_id, event_type, signature_ok,
                                   body_enc, body_key_version, request_id)
       VALUES ($1, app_tenant_id(), $2, $3, $4, true, $5, $6, $7)
       ON CONFLICT (tenant_id, integration_id, external_event_id) DO NOTHING RETURNING id`,
      [
        id,
        integrationId,
        envelope.id,
        envelope.type,
        sealed.ciphertext,
        sealed.keyVersion,
        requestId,
      ],
    );
    if (!ins.rows[0]) {
      await client.query('COMMIT');
      logEvent('webhook.duplicate', { tenantId: integration.tenant_id, integrationId, requestId });
      return { status: 200, duplicate: true };
    }
    await emitEvent(client, {
      eventType: 'webhook.received',
      aggregateType: 'webhook_events',
      aggregateId: id,
      payload: { integration_id: integrationId, type: envelope.type },
      requestId,
    });
    await client.query('COMMIT');
    logEvent('webhook.received', {
      tenantId: integration.tenant_id,
      integrationId,
      webhookEventId: id,
      type: envelope.type,
      requestId,
    });
    return { status: 202, eventId: id };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
