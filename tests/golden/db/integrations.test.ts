import { randomBytes, randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeAudit, type AuditEntry } from '@/server/auth/audit';
import { PermissionDeniedError } from '@/server/auth/permissions';
import { InvalidRequestError, withTenant, type TenantContext } from '@/server/auth/with-tenant';
import { parseMasterKeyring } from '@/server/crypto/keyring';
import { createApiKey, hashToken } from '@/server/integrations/api-keys';
import { open } from '@/server/integrations/crypto';
import { receiveInbound } from '@/server/integrations/inbound';
import { dispatchDue, fanOut, validateOutboundUrl } from '@/server/integrations/outbound';
import { sameTx } from '@/server/jobs/tenant-job';
import { processWebhookEvent } from '@/server/integrations/process';
import { createIntegration, retryDeadLetter } from '@/server/integrations/service';
import { signatureHeader, verifySignature } from '@/server/integrations/signing';
import { ensureFixtures, FX } from './fixtures';
import { appPool, closePools, inTenant, inTenantCommit, migratePool } from './helpers';

// Golden (never delete or skip) — task 4.1 integration framework:
//   - an API key acts only within its scopes, in ITS tenant, audited as 'api_key'; revoked = 401;
//     a key never gets more than its creator nor a checker permission;
//   - inbound webhooks: no/foreign signature → 401, stale timestamp (replay) → 401, nothing
//     stored; the same external event id twice = one row; the body is stored encrypted;
//   - processing: an unknown type is a dead letter, retry puts it back;
//   - outbound: one delivery per subscribed integration, signed with the integration secret,
//     backoff on failure, a demo tenant only records ('sink').

const keyring = parseMasterKeyring(`1:${randomBytes(32).toString('base64')}`);
const BASE = 'http://golden.test';
const created: { tenant: string; integration: string }[] = [];
const keys: string[] = [];

beforeAll(async () => {
  await ensureFixtures();
});
afterAll(async () => {
  // Inbound tests commit through their own connection; remove what they created.
  for (const c of created) {
    await inTenantCommit(migratePool, c.tenant, async (db) => {
      for (const table of [
        'webhook_events',
        'sync_runs',
        'outbound_deliveries',
        'integration_credentials',
      ]) {
        await db.query(`DELETE FROM ${table} WHERE integration_id = $1`, [c.integration]);
      }
      await db.query('DELETE FROM integrations WHERE id = $1', [c.integration]);
    });
  }
  await inTenantCommit(migratePool, FX.tenantA, async (db) => {
    await db.query('DELETE FROM api_keys WHERE id = ANY($1::uuid[])', [keys]);
  });
  await closePools();
});

function ctxFor(
  db: PoolClient,
  tenantId: string = FX.tenantA,
  userId: string = FX.userA,
): TenantContext {
  const requestId = randomUUID();
  return {
    db,
    tenantId,
    userId,
    authUserId: 'golden',
    requestId,
    requirePermission: async (key) => ({ key, scope: 'ORGANIZATION' }),
    requireAnyPermission: async (k) => ({ key: k[0] ?? '', scope: 'ORGANIZATION' }),
    audit: (entry) => writeAudit(db, { type: 'user', id: userId }, entry, requestId),
  };
}

const jobAudit = (db: PoolClient) => (entry: AuditEntry) =>
  writeAudit(db, { type: 'job', id: null }, entry, null);

/** A committed integration (inbound runs in its own transaction); returns id + secret. */
async function committedIntegration(
  tenantId: string,
  extra: { outboundUrl?: string } = {},
): Promise<{ id: string; secret: string }> {
  let out = { id: '', secret: '' };
  await inTenantCommit(appPool, tenantId, async (db) => {
    const r = await createIntegration(
      ctxFor(db, tenantId, tenantId === FX.tenantA ? FX.userA : FX.userB),
      { type: 'webhook', name: `golden ${randomUUID().slice(0, 6)}`, ...extra },
      keyring,
    );
    out = { id: r.id, secret: r.secret };
  });
  created.push({ tenant: tenantId, integration: out.id });
  return out;
}

function inbound(id: string, body: object, secret: string | null, at: Date = new Date()) {
  const raw = JSON.stringify(body);
  const headers = new Headers({ 'content-type': 'application/json' });
  if (secret) headers.set('x-signature', signatureHeader(secret, raw, at));
  return receiveInbound(appPool, keyring, id, raw, headers, randomUUID());
}

describe('golden/db: API keys (4.1)', () => {
  it('a key acts only within its scopes and its tenant; audited as api_key; revoked = 401', async () => {
    const token = `ak_${randomBytes(32).toString('base64url')}`;
    let keyId = '';
    await inTenantCommit(migratePool, FX.tenantA, async (db) => {
      const r = await db.query<{ id: string }>(
        `INSERT INTO api_keys (tenant_id, name, token_prefix, key_hash, scopes, created_by, scope, activated_at)
         VALUES ($1, 'golden key', $2, $3, ARRAY['customer.read'], $4, 'ORGANIZATION', now()) RETURNING id`,
        [FX.tenantA, token.slice(0, 12), hashToken(token), FX.userA],
      );
      keyId = r.rows[0]?.id ?? '';
    });
    keys.push(keyId);
    const handler = (permission: string) =>
      withTenant(
        async (_req, ctx) => {
          await ctx.requirePermission(permission);
          await ctx.audit({
            action: 'golden.api_key_call',
            entityType: 'api_keys',
            entityId: keyId,
          });
          const { rows } = await ctx.db.query<{ t: string; foreign: number }>(
            `SELECT app_tenant_id()::text AS t,
                    (SELECT count(*)::int FROM customers WHERE tenant_id <> app_tenant_id()) AS foreign`,
          );
          return NextResponse.json({ ...rows[0], actor: ctx.actorType });
        },
        {
          appPool: () => appPool,
          allowedOrigin: () => BASE,
          resolveIdentity: async () => null,
        },
      );
    const call = (permission: string, auth = `Bearer ${token}`) =>
      handler(permission)(
        new NextRequest(`${BASE}/api/test`, { method: 'POST', headers: { authorization: auth } }),
        { params: Promise.resolve({}) },
      );
    const ok = await call('customer.read');
    const okBody = (await ok.json()) as Record<string, unknown>;
    const denied = await call('invoice.read');
    const bad = await call('customer.read', `Bearer ak_${'x'.repeat(43)}`);
    const audit = await inTenant(migratePool, FX.tenantA, (db) =>
      db
        .query<{ actor_type: string; actor_id: string }>(
          `SELECT actor_type, actor_id FROM audit_log WHERE action = 'golden.api_key_call' AND entity_id = $1`,
          [keyId],
        )
        .then((r) => r.rows),
    );
    await inTenantCommit(migratePool, FX.tenantA, async (db) => {
      await db.query('UPDATE api_keys SET revoked_at = now(), revoked_by = $2 WHERE id = $1', [
        keyId,
        FX.userA,
      ]);
    });
    const revoked = await call('customer.read');
    expect(ok.status).toBe(200);
    expect(okBody).toEqual({ t: FX.tenantA, foreign: 0, actor: 'api_key' });
    expect(denied.status).toBe(403);
    expect(bad.status).toBe(401);
    expect(audit).toEqual([{ actor_type: 'api_key', actor_id: keyId }]);
    expect(revoked.status).toBe(401);
  });

  it('a key never gets a checker permission nor more than its creator; the token is not stored', async () => {
    const out = await inTenant(appPool, FX.tenantA, async (db) => {
      await db.query(
        `INSERT INTO user_roles (tenant_id, user_id, role_id, scope) VALUES ($1, $2, $3, 'ORGANIZATION')
         ON CONFLICT DO NOTHING`,
        [FX.tenantA, FX.userA, FX.roleA],
      );
      await db.query(
        `INSERT INTO role_permissions (tenant_id, role_id, permission_id)
         SELECT $1, $2, p.id FROM permissions p WHERE p.key IN ('customer.read', 'approval.write_off')
         ON CONFLICT DO NOTHING`,
        [FX.tenantA, FX.roleA],
      );
      const ctx = ctxFor(db);
      const checker = await createApiKey(ctx, { name: 'x', scopes: ['approval.write_off'] }).catch(
        (e: unknown) => e,
      );
      const escalate = await createApiKey(ctx, { name: 'x', scopes: ['invoice.read'] }).catch(
        (e: unknown) => e,
      );
      const key = await createApiKey(ctx, { name: 'n8n', scopes: ['customer.read'] });
      const row = await db.query<{ raw: string }>(
        `SELECT encode(key_hash, 'escape') || token_prefix || array_to_string(scopes, ',') AS raw FROM api_keys WHERE id = $1`,
        [key.id],
      );
      return { checker, escalate, key, raw: row.rows[0]?.raw ?? '' };
    });
    expect(out.checker).toBeInstanceOf(InvalidRequestError);
    expect(out.escalate).toBeInstanceOf(PermissionDeniedError);
    expect(out.key.token).toMatch(/^ak_[A-Za-z0-9_-]{43}$/);
    expect(out.raw).not.toContain(out.key.token);
  });
});

describe('golden/db: inbound webhook (4.1)', () => {
  it('signature, replay window and exactly-once; the body is stored encrypted', async () => {
    const a = await committedIntegration(FX.tenantA);
    const b = await committedIntegration(FX.tenantB);
    const id = `evt-${randomUUID()}`;
    const body = { id, type: 'integration.ping', data: { marker: 'PLAINTEXT-MARKER' } };
    const unsigned = await inbound(a.id, body, null);
    const foreign = await inbound(a.id, body, b.secret);
    const stale = await inbound(a.id, body, a.secret, new Date(Date.now() - 6 * 60_000));
    const unknown = await inbound(randomUUID(), body, a.secret);
    const first = await inbound(a.id, body, a.secret);
    const again = await inbound(a.id, body, a.secret);
    const rows = await inTenant(migratePool, FX.tenantA, (db) =>
      db
        .query<{ id: string; raw: string; body_enc: Buffer; body_key_version: number }>(
          `SELECT id, encode(body_enc, 'escape') AS raw, body_enc, body_key_version FROM webhook_events
           WHERE integration_id = $1`,
          [a.id],
        )
        .then((r) => r.rows),
    );
    const inB = await inTenant(migratePool, FX.tenantB, (db) =>
      db
        .query('SELECT 1 FROM webhook_events WHERE external_event_id = $1', [id])
        .then((r) => r.rowCount),
    );
    expect(unsigned).toEqual({ status: 401, code: 'unauthorized' });
    expect(foreign).toEqual({ status: 401, code: 'unauthorized' });
    expect(stale).toEqual({ status: 401, code: 'unauthorized' });
    expect(unknown).toEqual({ status: 401, code: 'unauthorized' });
    expect(first.status).toBe(202);
    expect(again).toEqual({ status: 200, duplicate: true });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.raw).not.toContain('PLAINTEXT-MARKER');
    expect(
      open(keyring, FX.tenantA, 'webhook_events.body', rows[0]?.id ?? '', {
        ciphertext: rows[0]?.body_enc ?? Buffer.alloc(0),
        keyVersion: rows[0]?.body_key_version ?? 1,
      }),
    ).toContain('PLAINTEXT-MARKER');
    expect(inB).toBe(0);
  });

  it('the worker processes a ping; an unknown type is a dead letter that can be retried', async () => {
    const a = await committedIntegration(FX.tenantA);
    const ping = await inbound(
      a.id,
      { id: `p-${randomUUID()}`, type: 'integration.ping', data: {} },
      a.secret,
    );
    const odd = await inbound(
      a.id,
      { id: `u-${randomUUID()}`, type: 'golden.unknown', data: {} },
      a.secret,
    );
    const out = await inTenant(appPool, FX.tenantA, async (db) => {
      const p = await processWebhookEvent(
        db,
        jobAudit(db),
        keyring,
        'eventId' in ping ? ping.eventId : '',
      );
      const u = await processWebhookEvent(
        db,
        jobAudit(db),
        keyring,
        'eventId' in odd ? odd.eventId : '',
      );
      const dead = await db.query<{ status: string; dead_letter_reason: string }>(
        'SELECT status, dead_letter_reason FROM webhook_events WHERE id = $1',
        ['eventId' in odd ? odd.eventId : ''],
      );
      await retryDeadLetter(ctxFor(db), 'eventId' in odd ? odd.eventId : '', { kind: 'webhook' });
      const after = await db.query<{ status: string }>(
        'SELECT status FROM webhook_events WHERE id = $1',
        ['eventId' in odd ? odd.eventId : ''],
      );
      const runs = await db.query<{ status: string }>(
        `SELECT status FROM sync_runs WHERE integration_id = $1 ORDER BY started_at`,
        [a.id],
      );
      return {
        p,
        u,
        dead: dead.rows[0],
        after: after.rows[0]?.status,
        runs: runs.rows.map((r) => r.status),
      };
    });
    expect(out.p).toBe('processed');
    expect(out.u).toBe('dead');
    expect(out.dead).toEqual({ status: 'dead', dead_letter_reason: 'unknown_event_type' });
    expect(out.after).toBe('received');
    expect(out.runs.sort()).toEqual(['failed', 'succeeded']);
  });
});

describe('golden/db: outbound deliveries (4.1)', () => {
  it('fan-out once per subscribed integration, signed POST, backoff, demo = sink', async () => {
    // vigor_migrate: the test flips tenants.is_demo (the app role cannot), all rolled back.
    const out = await inTenant(migratePool, FX.tenantA, async (db) => {
      const ctx = ctxFor(db);
      const sub = await createIntegration(
        ctx,
        {
          type: 'webhook',
          name: 'n8n out',
          outboundUrl: 'http://n8n.test/hook',
          events: ['promise.broken'],
        },
        keyring,
      );
      await createIntegration(
        ctx,
        {
          type: 'webhook',
          name: 'not subscribed',
          outboundUrl: 'http://n8n.test/other',
          events: [],
        },
        keyring,
      );
      const ev = await db.query<{ id: string }>(
        `INSERT INTO domain_events (tenant_id, event_type, aggregate_type, aggregate_id, payload)
         VALUES (app_tenant_id(), 'promise.broken', 'promises', $1, '{"case_id": null}') RETURNING id`,
        [randomUUID()],
      );
      const event = { id: ev.rows[0]?.id ?? '', eventType: 'promise.broken' };
      const n1 = await fanOut(db, event);
      const n2 = await fanOut(db, event);
      const seen: { url: string; signature: string; body: string }[] = [];
      let status = 500;
      const fakeFetch = async (url: string, init: RequestInit) => {
        seen.push({
          url,
          signature: String((init.headers as Record<string, string>)['x-signature']),
          body: String(init.body),
        });
        return { status };
      };
      const now = new Date();
      await db.query('UPDATE tenants SET is_demo = false WHERE id = $1', [FX.tenantA]);
      const failed = await dispatchDue(sameTx(db), keyring, fakeFetch, now);
      const backoff = await db.query<{ status: string; attempts: number; delay: number }>(
        `SELECT status, attempts, extract(epoch FROM next_attempt_at - $2::timestamptz)::int AS delay
         FROM outbound_deliveries WHERE event_id = $1`,
        [event.id, now],
      );
      status = 204;
      const later = new Date(now.getTime() + 61_000);
      const sent = await dispatchDue(sameTx(db), keyring, fakeFetch, later);
      const secret = await db.query<{ id: string; secret_enc: Buffer; key_version: number }>(
        `SELECT id, secret_enc, secret_key_version AS key_version FROM integration_credentials WHERE integration_id = $1`,
        [sub.id],
      );
      const s = secret.rows[0];
      const plain = s
        ? open(keyring, FX.tenantA, 'integration_credentials.secret', s.id, {
            ciphertext: s.secret_enc,
            keyVersion: s.key_version,
          })
        : '';
      // A demo tenant records, never sends.
      await db.query('UPDATE tenants SET is_demo = true WHERE id = $1', [FX.tenantA]);
      await db.query(
        `UPDATE outbound_deliveries SET status = 'pending', sent_at = NULL, next_attempt_at = now() - interval '1 second'
         WHERE event_id = $1`,
        [event.id],
      );
      const before = seen.length;
      const demo = await dispatchDue(sameTx(db), keyring, fakeFetch, new Date(Date.now() + 1000));
      return {
        n1,
        n2,
        failed,
        backoff: backoff.rows[0],
        sent,
        seen,
        plain,
        before,
        demo,
        secretCheck: sub.secret,
      };
    });
    expect(out.n1).toBe(1);
    expect(out.n2).toBe(0);
    expect(out.failed).toMatchObject({ failed: 1, sent: 0 });
    expect(out.backoff).toMatchObject({ status: 'failed', attempts: 1, delay: 60 });
    expect(out.sent).toMatchObject({ sent: 1 });
    expect(out.seen[1]?.url).toBe('http://n8n.test/hook');
    expect(out.plain).toBe(out.secretCheck);
    expect(
      verifySignature(
        out.seen[1]?.signature ?? null,
        out.seen[1]?.body ?? '',
        out.plain,
        new Date(Date.now() + 61_000),
      ),
    ).toBe('ok');
    expect(JSON.parse(out.seen[1]?.body ?? '{}')).toMatchObject({
      type: 'promise.broken',
      data: { aggregateType: 'promises' },
    });
    expect(out.demo).toMatchObject({ sink: 1, sent: 0 });
    expect(out.seen.length).toBe(out.before);
  });

  it('outbound URLs: https in production, no credentials, no private or local hosts', () => {
    expect(validateOutboundUrl('https://n8n.example.com/webhook/x', true)).toBe(true);
    expect(validateOutboundUrl('http://n8n.example.com/webhook/x', true)).toBe(false);
    expect(validateOutboundUrl('https://user:pw@n8n.example.com/', true)).toBe(false);
    expect(validateOutboundUrl('https://127.0.0.1/', true)).toBe(false);
    expect(validateOutboundUrl('https://10.1.2.3/', true)).toBe(false);
    expect(validateOutboundUrl('https://localhost/', true)).toBe(false);
    expect(validateOutboundUrl('http://localhost:5678/', false)).toBe(true);
    expect(validateOutboundUrl('ftp://n8n.example.com/', false)).toBe(false);
  });
});
