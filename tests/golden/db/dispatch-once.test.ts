import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { writeAudit } from '@/server/auth/audit';
import type { TenantContext } from '@/server/auth/with-tenant';
import { getMasterKeyring } from '@/server/crypto/keyring';
import type { Queryable } from '@/server/crypto/subject-keys';
import { createIntegration } from '@/server/integrations/service';
import type { TenantTx } from '@/server/jobs/tenant-job';
import { dispatchIntegrations } from '@/server/jobs/worker';
import { dispatchIntegrationMail } from '@/server/mail/dispatch-integration';
import { sealMail } from '@/server/mail/crypto';
import { appPool, closePools, inTenant, inTenantCommit, migratePool, workerPool } from './helpers';

// Golden (never delete or skip) — review S-09: a mail handed to n8n is never handed over again.
//   - an error in another mail of the same run (rollback) does not resend a mail already POSTed;
//   - a crash after the POST: not resent while the claim's lease runs; afterwards it is retried
//     with the SAME Idempotency-Key, so the n8n template drops the repeat.
// Own non-demo tenant; committed rows are removed in afterAll.

process.env.PII_MASTER_KEYS = `1:${randomBytes(32).toString('base64')}`;
const keyring = getMasterKeyring();

const T = {
  tenant: '0d000000-0000-4000-8000-0000000000d1',
  user: '3d000000-0000-4000-8000-0000000000d1',
} as const;
let integrationId = '';
let customerId = '';
const mails: string[] = [];

type Post = { url: string; key: string | null; outboxId: string };
const posts: Post[] = [];
const fakeFetch = async (url: string, init: RequestInit) => {
  const headers = init.headers as Record<string, string>;
  const body = JSON.parse(String(init.body)) as { id: string };
  posts.push({ url, key: headers['idempotency-key'] ?? null, outboxId: body.id });
  return { status: 200, text: async () => JSON.stringify({ messageId: `<${body.id}@mx.test>` }) };
};

function ctxFor(db: Queryable): TenantContext {
  const requestId = randomUUID();
  return {
    db: db as TenantContext['db'],
    tenantId: T.tenant,
    userId: T.user,
    authUserId: 'golden',
    requestId,
    requirePermission: async (key) => ({ key, scope: 'ORGANIZATION' }),
    requireAnyPermission: async (k) => ({ key: k[0] ?? '', scope: 'ORGANIZATION' }),
    audit: (entry) => writeAudit(db, { type: 'user', id: T.user }, entry, requestId),
  };
}

/** Committed tenant transactions as vigor_app — the worker's tenantTx() without a job id. */
function committed(onCall?: () => void): TenantTx {
  return async (fn) => {
    onCall?.();
    const client = await appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [T.tenant]);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  };
}

/** A pending integration mail; `readable: false` = a body that cannot be decrypted. */
async function queueMail(readable: boolean): Promise<string> {
  const id = randomUUID();
  const to = sealMail(keyring, T.tenant, 'recipient', id, 'kupac@example.test');
  const body = sealMail(
    keyring,
    T.tenant,
    'body',
    id,
    JSON.stringify({ subject: 'Opomena', text: 'Poštovani', html: '<p>Poštovani</p>' }),
  );
  await inTenantCommit(migratePool, T.tenant, async (db) => {
    await db.query(
      `INSERT INTO mail_outbox (id, tenant_id, kind, transport, status, recipient_enc, recipient_key_version,
                                body_enc, body_key_version, customer_id, integration_id, message_id,
                                next_attempt_at, created_at)
       VALUES ($1, $2, 'reminder', 'integration', 'pending', $3, $4, $5, $6, $7, $8, $9, now(),
               clock_timestamp())`,
      [
        id,
        T.tenant,
        to.ciphertext,
        to.keyVersion,
        readable ? body.ciphertext : randomBytes(48),
        body.keyVersion,
        customerId,
        integrationId,
        `<${id}@golden.test>`,
      ],
    );
  });
  mails.push(id);
  return id;
}

async function mailState(id: string) {
  return inTenant(appPool, T.tenant, async (db) => {
    const { rows } = await db.query<{ status: string; status_reason: string | null }>(
      'SELECT status, status_reason FROM mail_outbox WHERE id = $1',
      [id],
    );
    return rows[0];
  });
}

beforeAll(async () => {
  await inTenantCommit(migratePool, T.tenant, async (c) => {
    await c.query(
      `INSERT INTO tenants (id, slug, display_name, is_demo) VALUES ($1, 'golden-once', 'golden-once', false)
       ON CONFLICT (id) DO UPDATE SET is_demo = false`,
      [T.tenant],
    );
    await c.query(
      `INSERT INTO tenant_settings (tenant_id, timezone, default_currency, country_code)
       VALUES ($1, 'UTC', 'EUR', 'XX') ON CONFLICT (tenant_id) DO NOTHING`,
      [T.tenant],
    );
    await c.query(
      `INSERT INTO users (id, tenant_id, email, display_name, timezone, status)
       VALUES ($1, $2, 'member@golden-once.example.test', 'Golden Once', 'UTC', 'active')
       ON CONFLICT (id) DO NOTHING`,
      [T.user, T.tenant],
    );
  });
  await inTenantCommit(migratePool, T.tenant, async (db) => {
    const le = await db.query<{ id: string }>(
      `SELECT find_or_create_legal_entity('XX', $1, 'Once Kupac', 'UTC', NULL) AS id`,
      [`ONCE-${randomUUID().slice(0, 12)}`],
    );
    const c = await db.query<{ id: string }>(
      `INSERT INTO customers (tenant_id, legal_entity_id, display_name) VALUES ($1, $2, 'Once Kupac') RETURNING id`,
      [T.tenant, le.rows[0]?.id],
    );
    customerId = c.rows[0]?.id ?? '';
    const integ = await createIntegration(
      ctxFor(db),
      { type: 'mailbox', name: 'once', outboundUrl: 'http://n8n.test/once' },
      keyring,
    );
    integrationId = integ.id;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  posts.length = 0;
});

afterAll(async () => {
  await inTenantCommit(migratePool, T.tenant, async (db) => {
    await db.query(
      `DELETE FROM domain_events WHERE aggregate_type = 'mail_outbox' AND aggregate_id = ANY($1)`,
      [mails],
    );
    await db.query('DELETE FROM mail_outbox WHERE id = ANY($1)', [mails]);
  });
  await inTenantCommit(migratePool, T.tenant, async (db) => {
    for (const table of [
      'webhook_events',
      'sync_runs',
      'outbound_deliveries',
      'integration_credentials',
    ]) {
      await db.query(`DELETE FROM ${table} WHERE integration_id = $1`, [integrationId]);
    }
    await db.query('DELETE FROM integrations WHERE id = $1', [integrationId]);
    await db.query('DELETE FROM customers WHERE id = $1', [customerId]);
  });
  await closePools();
});

describe('golden/db: a mail handed to n8n is never handed over twice (review S-09)', () => {
  it('a bad mail in the same run (rollback) does not resend the good one already POSTed', async () => {
    vi.stubGlobal('fetch', fakeFetch);
    const good = await queueMail(true);
    const bad = await queueMail(false);

    await dispatchIntegrations(workerPool(), appPool, 'golden-once-1');
    await dispatchIntegrations(workerPool(), appPool, 'golden-once-2');

    expect(posts.filter((p) => p.outboxId === good)).toHaveLength(1);
    expect(posts.filter((p) => p.outboxId === bad)).toHaveLength(0);
    expect(await mailState(good)).toMatchObject({ status: 'sent' });
    expect(await mailState(bad)).toEqual({
      status: 'failed',
      status_reason: 'dispatch.unreadable',
    });
  });

  it('a crash after the POST: nothing within the lease, then the same Idempotency-Key', async () => {
    const id = await queueMail(true);
    const now = new Date();
    let posted = false;
    const crashing = committed(() => {
      if (posted) throw new Error('process died after the POST');
    });
    const fetchOnce = async (url: string, init: RequestInit) => {
      posted = true;
      return fakeFetch(url, init);
    };

    await dispatchIntegrationMail(crashing, keyring, fetchOnce, now);
    expect(posts).toHaveLength(1);
    expect(await mailState(id)).toMatchObject({
      status: 'pending',
      status_reason: 'dispatch.claimed',
    });

    // The next runs within the lease: the mail is claimed — no second POST.
    await dispatchIntegrationMail(committed(), keyring, fakeFetch, now);
    await dispatchIntegrationMail(
      committed(),
      keyring,
      fakeFetch,
      new Date(now.getTime() + 60_000),
    );
    expect(posts).toHaveLength(1);

    // After the lease: retried once more, with the key n8n deduplicates on.
    await dispatchIntegrationMail(
      committed(),
      keyring,
      fakeFetch,
      new Date(now.getTime() + 11 * 60_000),
    );
    expect(posts).toHaveLength(2);
    expect(posts.map((p) => p.key)).toEqual([id, id]);
    expect(await mailState(id)).toMatchObject({ status: 'sent' });
  });
});
