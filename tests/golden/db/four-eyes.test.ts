import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decideApproval } from '@/server/approvals/service';
import { createInvitation } from '@/server/auth/invitations';
import { createTenantContext } from '@/server/auth/with-tenant';
import { parseMasterKeyring } from '@/server/crypto/keyring';
import { apiKeyIdentity, createApiKey } from '@/server/integrations/api-keys';
import { openMail } from '@/server/mail/crypto';
import { grantsByRole, parsePermissionMatrix } from '@/server/permissions/matrix';
import { changeMemberRole } from '@/server/users/service';
import { appPool, closePools, inTenant, inTenantCommit, migratePool, sqlState } from './helpers';

// Golden (never delete or skip) — security review S-06: who may become a checker.
//   - an invitation or role change INTO a privileged role (owner, admin, cfo, collection_manager)
//     waits for a SECOND administrator: no token, no mail, no role until another one approves;
//   - the requester never approves their own request;
//   - an API key with ORGANIZATION scope does not authenticate until approved, and only a creator
//     holding every chosen permission with ORGANIZATION may ask for it (no widening, S-16);
//   - bootstrap: a tenant with exactly ONE active administrator applies these directly.
// Own tenants: P (two administrators) and Q (one administrator).

const keyring = parseMasterKeyring(`1:${randomBytes(32).toString('base64')}`);
const deps = { keyring, baseURL: 'http://localhost:3000' };
const T = {
  p: '0f100000-0000-4000-8000-0000000000f1',
  q: '0f200000-0000-4000-8000-0000000000f2',
} as const;
const U = {
  pOwner: '3f100000-0000-4000-8000-0000000000f1',
  pAdmin: '3f100000-0000-4000-8000-0000000000f2',
  pCollector: '3f100000-0000-4000-8000-0000000000f3',
  qAdmin: '3f200000-0000-4000-8000-0000000000f1',
  qCollector: '3f200000-0000-4000-8000-0000000000f2',
} as const;
const MEMBERS: [string, string, string, 'OWN' | 'ORGANIZATION'][] = [
  [T.p, U.pOwner, 'owner', 'ORGANIZATION'],
  [T.p, U.pAdmin, 'admin', 'ORGANIZATION'],
  [T.p, U.pCollector, 'collector', 'OWN'],
  [T.q, U.qAdmin, 'admin', 'ORGANIZATION'],
  [T.q, U.qCollector, 'collector', 'OWN'],
];
const RUN = randomUUID().slice(0, 8);
const STARTED = new Date();

const ctxFor = (c: PoolClient, tenantId: string, userId: string) =>
  createTenantContext(c, { tenantId, userId, authUserId: randomUUID(), requestId: randomUUID() });

/** Runs `fn` as `userId` in a COMMITTED tenant transaction (like one request). */
async function as<R>(
  tenantId: string,
  userId: string,
  fn: (ctx: ReturnType<typeof ctxFor>) => Promise<R>,
): Promise<R> {
  let out: R | undefined;
  await inTenantCommit(appPool, tenantId, async (c) => {
    out = await fn(ctxFor(c, tenantId, userId));
  });
  return out as R;
}

const invitationsFor = (tenantId: string, email: string) =>
  inTenant(appPool, tenantId, async (c) => {
    const { rows } = await c.query<{ status: string }>(
      `SELECT i.status FROM user_invitations i JOIN users u ON u.id = i.user_id WHERE u.email = $1`,
      [email],
    );
    return rows.map((r) => r.status);
  });

/** Invitation mails of THIS run to `email` (rows of earlier runs use another test key). */
const mailsTo = (tenantId: string, email: string) =>
  inTenant(appPool, tenantId, async (c) => {
    const { rows } = await c.query<{
      id: string;
      recipient_enc: Buffer;
      recipient_key_version: number;
    }>(
      `SELECT id, recipient_enc, recipient_key_version FROM mail_outbox
       WHERE kind = 'invitation' AND created_at >= $1`,
      [STARTED],
    );
    return rows.filter(
      (r) =>
        openMail(keyring, tenantId, 'recipient', r.id, {
          ciphertext: r.recipient_enc,
          keyVersion: r.recipient_key_version,
        }) === email,
    ).length;
  });

beforeAll(async () => {
  const grants = grantsByRole(
    parsePermissionMatrix(
      readFileSync(new URL('../../../docs/permissions.md', import.meta.url), 'utf8'),
    ),
  );
  await inTenantCommit(migratePool, null, async (c) => {
    await c.query(
      `INSERT INTO jurisdiction_profiles (country_code, default_currency, default_locale, default_timezone)
       VALUES ('XX', 'EUR', 'en', 'UTC') ON CONFLICT (country_code) DO NOTHING`,
    );
  });
  for (const [tenantId, slug] of [
    [T.p, 'golden-four-eyes-p'],
    [T.q, 'golden-four-eyes-q'],
  ] as const) {
    await inTenantCommit(migratePool, tenantId, async (c) => {
      await c.query(
        `INSERT INTO tenants (id, slug, display_name, is_demo) VALUES ($1, $2, $2, true)
         ON CONFLICT (id) DO NOTHING`,
        [tenantId, slug],
      );
      await c.query(
        `INSERT INTO tenant_settings (tenant_id, timezone, default_currency, country_code)
         VALUES ($1, 'UTC', 'EUR', 'XX') ON CONFLICT (tenant_id) DO NOTHING`,
        [tenantId],
      );
      for (const role of ['owner', 'admin', 'cfo', 'collection_manager', 'collector']) {
        await c.query(
          `INSERT INTO roles (tenant_id, key, is_system) VALUES ($1, $2, true)
           ON CONFLICT (tenant_id, key) DO NOTHING`,
          [tenantId, role],
        );
        await c.query(
          `INSERT INTO role_permissions (tenant_id, role_id, permission_id)
           SELECT $1, r.id, p.id FROM roles r JOIN permissions p ON p.key = ANY($3::text[])
           WHERE r.key = $2 ON CONFLICT DO NOTHING`,
          [tenantId, role, grants.get(role) ?? []],
        );
      }
    });
  }
  for (const [tenantId, userId, role, scope] of MEMBERS) {
    await inTenantCommit(migratePool, tenantId, async (c) => {
      await c.query(
        `INSERT INTO users (id, tenant_id, email, display_name, timezone, status)
         VALUES ($1, $2, $3, 'Golden Four Eyes', 'UTC', 'active')
         ON CONFLICT (id) DO UPDATE SET status = 'active'`,
        [userId, tenantId, `${role}-${userId.slice(-2)}@four-eyes.example.test`],
      );
      await c.query('DELETE FROM user_roles WHERE user_id = $1', [userId]);
      await c.query(
        `INSERT INTO user_roles (tenant_id, user_id, role_id, scope)
         SELECT $1, $2, id, $4 FROM roles WHERE key = $3`,
        [tenantId, userId, role, scope],
      );
    });
  }
});

afterAll(async () => {
  for (const tenantId of [T.p, T.q]) {
    await inTenantCommit(migratePool, tenantId, async (c) => {
      await c.query(`UPDATE approval_requests SET status = 'cancelled' WHERE status = 'pending'`);
      await c.query(
        `UPDATE api_keys SET revoked_at = now(), revoked_by = $1 WHERE revoked_at IS NULL`,
        [tenantId === T.p ? U.pOwner : U.qAdmin],
      );
    });
  }
  await closePools();
});

describe('golden/db: privileged invitations need a second administrator (S-06)', () => {
  it('an admin invites a cfo: no token, no mail until another administrator approves', async () => {
    const email = `cfo-${RUN}@four-eyes.example.test`;
    const created = await as(T.p, U.pAdmin, (ctx) =>
      createInvitation(ctx, deps, { email, displayName: 'New CFO', roleKey: 'cfo' }),
    );
    expect(created.status).toBe('approval_required');
    expect(await invitationsFor(T.p, email)).toEqual([]);
    expect(await mailsTo(T.p, email)).toBe(0);
    const approvalId = created.status === 'approval_required' ? created.approvalId : '';

    // The requester never decides their own request.
    expect(
      await sqlState(
        as(T.p, U.pAdmin, (ctx) => decideApproval(ctx, approvalId, { decision: 'approve' }, deps)),
      ),
    ).not.toBe('OK');
    // A collector has no user.assign.
    expect(
      await sqlState(
        as(T.p, U.pCollector, (ctx) =>
          decideApproval(ctx, approvalId, { decision: 'approve' }, deps),
        ),
      ),
    ).not.toBe('OK');
    expect(await invitationsFor(T.p, email)).toEqual([]);

    const decided = await as(T.p, U.pOwner, (ctx) =>
      decideApproval(ctx, approvalId, { decision: 'approve' }, deps),
    );
    expect(decided).toEqual({ status: 'approved' });
    expect(await invitationsFor(T.p, email)).toEqual(['pending']);
    expect(await mailsTo(T.p, email)).toBe(1);
  });

  it('an ordinary role (collector) is invited at once', async () => {
    const email = `collector-${RUN}@four-eyes.example.test`;
    const created = await as(T.p, U.pAdmin, (ctx) =>
      createInvitation(ctx, deps, { email, displayName: 'New Collector', roleKey: 'collector' }),
    );
    expect(created.status).toBe('sent');
    expect(await invitationsFor(T.p, email)).toEqual(['pending']);
  });

  it('bootstrap: the only administrator of a tenant invites an admin directly', async () => {
    const email = `admin-${RUN}@four-eyes.example.test`;
    const created = await as(T.q, U.qAdmin, (ctx) =>
      createInvitation(ctx, deps, { email, displayName: 'Second Admin', roleKey: 'admin' }),
    );
    expect(created.status).toBe('sent');
    expect(await invitationsFor(T.q, email)).toEqual(['pending']);
  });
});

describe('golden/db: privileged role changes need a second administrator (S-06)', () => {
  it('collector → collection_manager waits for approval; bootstrap tenant applies it', async () => {
    const p = await as(T.p, U.pAdmin, (ctx) =>
      changeMemberRole(ctx, U.pCollector, { roleKey: 'collection_manager' }),
    );
    expect(p.status).toBe('approval_required');
    const q = await as(T.q, U.qAdmin, (ctx) =>
      changeMemberRole(ctx, U.qCollector, { roleKey: 'collection_manager' }),
    );
    expect(q).toEqual({ status: 'applied' });
  });
});

describe('golden/db: API keys wider than OWN (S-06 / S-16)', () => {
  it('an ORGANIZATION key does not authenticate until another administrator approves', async () => {
    const created = await as(T.p, U.pAdmin, (ctx) =>
      createApiKey(ctx, { name: 'org key', scopes: ['user.read'], scope: 'ORGANIZATION' }),
    );
    expect(created.scope).toBe('ORGANIZATION');
    expect(created.approvalId).toBeTruthy();
    expect(await apiKeyIdentity(appPool, created.token)).toBeNull();
    expect(
      await sqlState(
        as(T.p, U.pAdmin, (ctx) =>
          decideApproval(ctx, created.approvalId ?? '', { decision: 'approve' }, deps),
        ),
      ),
    ).not.toBe('OK');
    await as(T.p, U.pOwner, (ctx) =>
      decideApproval(ctx, created.approvalId ?? '', { decision: 'approve' }, deps),
    );
    expect(await apiKeyIdentity(appPool, created.token)).toMatchObject({
      tenantId: T.p,
      scope: 'ORGANIZATION',
      scopes: ['user.read'],
    });
  });

  it('an OWN key works at once and is granted OWN — never the whole organization', async () => {
    const created = await as(T.p, U.pAdmin, (ctx) =>
      createApiKey(ctx, { name: 'own key', scopes: ['user.read'] }),
    );
    expect(created).toMatchObject({ scope: 'OWN', approvalId: null });
    const identity = await apiKeyIdentity(appPool, created.token);
    expect(identity?.scope).toBe('OWN');
    const grant = await inTenant(appPool, T.p, (c) =>
      createTenantContext(c, {
        tenantId: T.p,
        userId: identity?.apiKeyId ?? '',
        authUserId: 'api_key',
        requestId: randomUUID(),
        ...({ apiKeyScopes: identity?.scopes, apiKeyScope: identity?.scope } as object),
      }).requirePermission('user.read'),
    );
    expect(grant).toEqual({ key: 'user.read', scope: 'OWN' });
  });

  it('a rejected ORGANIZATION key is revoked', async () => {
    const created = await as(T.p, U.pAdmin, (ctx) =>
      createApiKey(ctx, { name: 'org key 2', scopes: ['user.read'], scope: 'ORGANIZATION' }),
    );
    await as(T.p, U.pOwner, (ctx) =>
      decideApproval(ctx, created.approvalId ?? '', { decision: 'reject', note: 'no' }, deps),
    );
    expect(await apiKeyIdentity(appPool, created.token)).toBeNull();
    const revoked = await inTenant(
      appPool,
      T.p,
      async (c) =>
        (
          await c.query<{ revoked: boolean }>(
            'SELECT revoked_at IS NOT NULL AS revoked FROM api_keys WHERE id = $1',
            [created.id],
          )
        ).rows[0]?.revoked,
    );
    expect(revoked).toBe(true);
  });

  it('bootstrap: the only administrator gets an active ORGANIZATION key at once', async () => {
    const created = await as(T.q, U.qAdmin, (ctx) =>
      createApiKey(ctx, { name: 'boot key', scopes: ['user.read'], scope: 'ORGANIZATION' }),
    );
    expect(created.approvalId).toBeNull();
    expect((await apiKeyIdentity(appPool, created.token))?.scope).toBe('ORGANIZATION');
  });
});
