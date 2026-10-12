import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { NextRequest, NextResponse } from 'next/server';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The routes read their runtime (pools, auth) from the environment on first use: point it at
// the TEST database before any handler runs. Secrets are random per run and never printed.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.BETTER_AUTH_SECRET = randomBytes(32).toString('base64');
process.env.BETTER_AUTH_URL = 'http://localhost:3000';
process.env.PII_MASTER_KEYS = `1:${randomBytes(32).toString('base64')}`;

import { POST as revokeInvitation } from '@/app/api/invitations/[id]/revoke/route';
import { POST as createInvitationRoute } from '@/app/api/invitations/route';
import { GET as getUser } from '@/app/api/users/[id]/route';
import { apiErrorBody } from '@/lib/api-error';
import { REDACTED, writeAudit } from '@/server/auth/audit';
import { getAuth } from '@/server/auth/better-auth';
import { withTenant } from '@/server/auth/with-tenant';
import { grantsByRole, parsePermissionMatrix } from '@/server/permissions/matrix';
import { AuthClient, totp } from './auth-client';
import { appPool, closePools, inTenant, inTenantCommit, migratePool } from './helpers';

// Golden (never delete or skip) — task 1.2: withTenant() takes the tenant only from the
// session, requirePermission() answers 403 without detail, another tenant's id is 404 (IDOR),
// every mutation writes an audit row with the request id, audit snapshots are redacted, and
// X-Request-Id / X-App-Version are on every answer. Own tenants H and I.

const BASE_URL = 'http://localhost:3000';
const T = {
  tenantH: '0a100000-0000-4000-8000-0000000000a1',
  tenantI: '0a200000-0000-4000-8000-0000000000a2',
  ownerH: '3a100000-0000-4000-8000-0000000000a1',
  collectorH: '3a100000-0000-4000-8000-0000000000a2',
  cfoH: '3a100000-0000-4000-8000-0000000000a3', // user.read with scope OWN
  ownerI: '3a200000-0000-4000-8000-0000000000a1',
} as const;

const RUN = randomUUID().slice(0, 8);
const PASSWORD = `pw-${randomBytes(18).toString('base64url')}`;
const email = (name: string) => `${name}-${RUN}@tenant-api.example.test`;

type Person = {
  email: string;
  userId: string;
  tenantId: string;
  otpauth: string;
  client?: AuthClient;
};
const people: Record<'ownerH' | 'collectorH' | 'cfoH' | 'ownerI', Person> = {
  ownerH: { email: email('owner-h'), userId: T.ownerH, tenantId: T.tenantH, otpauth: '' },
  collectorH: {
    email: email('collector-h'),
    userId: T.collectorH,
    tenantId: T.tenantH,
    otpauth: '',
  },
  cfoH: { email: email('cfo-h'), userId: T.cfoH, tenantId: T.tenantH, otpauth: '' },
  ownerI: { email: email('owner-i'), userId: T.ownerI, tenantId: T.tenantI, otpauth: '' },
};

let ip = 0;
const newClient = () => new AuthClient(getAuth(), BASE_URL, `192.0.2.${(ip += 1)}`);

async function signedIn(person: Person): Promise<AuthClient> {
  const ctx = await getAuth().$context;
  const user = await ctx.internalAdapter.createUser(
    { email: person.email, name: 'Golden', emailVerified: true },
    { method: 'admin' },
  );
  await ctx.internalAdapter.linkAccount({
    userId: user.id,
    providerId: 'credential',
    accountId: user.id,
    password: await ctx.password.hash(PASSWORD),
  });
  await inTenantCommit(migratePool, person.tenantId, async (c) => {
    await c.query('UPDATE users SET auth_user_id = $1 WHERE id = $2', [user.id, person.userId]);
  });
  const client = newClient();
  await client.call('/sign-in/email', { email: person.email, password: PASSWORD });
  const enabled = (await client.call('/two-factor/enable', { password: PASSWORD })).json as {
    totpURI: string;
  };
  person.otpauth = enabled.totpURI;
  const verified = await client.call('/two-factor/verify-totp', { code: totp(enabled.totpURI) });
  expect(verified.status).toBe(200);
  return client;
}

function request(
  client: AuthClient | null,
  method: 'GET' | 'POST',
  path: string,
  init: { body?: unknown; headers?: Record<string, string> } = {},
): { req: NextRequest; requestId: string } {
  const requestId = randomUUID();
  const headers = new Headers(client ? client.headers() : undefined);
  headers.set('x-request-id', requestId);
  // Browsers send Origin on every fetch POST; withTenant() rejects mutations without our origin.
  headers.set('origin', BASE_URL);
  for (const [k, v] of Object.entries(init.headers ?? {})) headers.set(k, v);
  if (init.body !== undefined) headers.set('content-type', 'application/json');
  const req = new NextRequest(`${BASE_URL}${path}`, {
    method,
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  return { req, requestId };
}

const params = <P>(p: P) => ({ params: Promise.resolve(p) });

async function body(res: Response): Promise<unknown> {
  return JSON.parse(await res.text()) as unknown;
}

function expectHeaders(res: Response, requestId: string) {
  expect(res.headers.get('x-request-id')).toBe(requestId);
  expect(res.headers.get('x-app-version')).toBeTruthy();
}

async function auditRows(tenantId: string, requestId: string) {
  return inTenant(appPool, tenantId, async (c) => {
    const { rows } = await c.query<{ action: string; after: Record<string, unknown> | null }>(
      'SELECT action, after FROM audit_log WHERE request_id = $1 ORDER BY occurred_at, action',
      [requestId],
    );
    return rows;
  });
}

beforeAll(async () => {
  const matrix = parsePermissionMatrix(
    readFileSync(new URL('../../../docs/permissions.md', import.meta.url), 'utf8'),
  );
  const grants = grantsByRole(matrix);
  await inTenantCommit(migratePool, null, async (c) => {
    await c.query(
      `INSERT INTO jurisdiction_profiles (country_code, default_currency, default_locale, default_timezone)
       VALUES ('XX', 'EUR', 'en', 'UTC') ON CONFLICT (country_code) DO NOTHING`,
    );
  });
  for (const [tenantId, slug, members] of [
    [
      T.tenantH,
      'golden-api-h',
      [
        [T.ownerH, 'owner', 'ORGANIZATION'],
        [T.collectorH, 'collector', 'OWN'],
        [T.cfoH, 'cfo', 'OWN'],
      ],
    ],
    [T.tenantI, 'golden-api-i', [[T.ownerI, 'owner', 'ORGANIZATION']]],
  ] as const) {
    await inTenantCommit(migratePool, tenantId, async (c) => {
      await c.query(
        `INSERT INTO tenants (id, slug, display_name, is_demo) VALUES ($1, $2, $2, true)
         ON CONFLICT (id) DO UPDATE SET is_demo = true`,
        [tenantId, slug],
      );
      await c.query(
        `INSERT INTO tenant_settings (tenant_id, timezone, default_currency, country_code)
         VALUES ($1, 'UTC', 'EUR', 'XX') ON CONFLICT (tenant_id) DO NOTHING`,
        [tenantId],
      );
      for (const role of ['owner', 'collector', 'cfo']) {
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
      for (const [userId, role, scope] of members) {
        await c.query(
          `INSERT INTO users (id, tenant_id, email, display_name, timezone, status)
           VALUES ($1, $2, $3, 'Golden Member', 'UTC', 'active')
           ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name`,
          [userId, tenantId, `${role}@${slug}.example.test`],
        );
        await c.query(
          `INSERT INTO user_roles (tenant_id, user_id, role_id, scope)
           SELECT $1, $2, id, $4 FROM roles WHERE key = $3
           ON CONFLICT (tenant_id, user_id, role_id) DO UPDATE SET scope = EXCLUDED.scope`,
          [tenantId, userId, role, scope],
        );
      }
    });
  }
  for (const person of Object.values(people)) person.client = await signedIn(person);
});

afterAll(async () => {
  for (const tenantId of [T.tenantH, T.tenantI]) {
    await inTenantCommit(migratePool, tenantId, async (c) => {
      const runUsers = `SELECT id FROM users WHERE email::text LIKE '%-${RUN}@tenant-api.example.test'`;
      await c.query(`DELETE FROM user_invitations WHERE user_id IN (${runUsers})`);
      await c.query(`DELETE FROM users WHERE id IN (${runUsers})`);
      await c.query('UPDATE users SET auth_user_id = NULL');
      await c.query('DELETE FROM mail_outbox');
    });
  }
  await migratePool.query(`DELETE FROM auth."user" WHERE email LIKE $1`, [
    `%-${RUN}@tenant-api.example.test`,
  ]);
  await migratePool.query(`DELETE FROM auth."rateLimit" WHERE key LIKE '192.0.2.%'`);
  await closePools();
});

const invitePayload = (name: string, roleKey = 'collector') => ({
  email: email(name),
  displayName: 'Golden Invitee',
  roleKey,
});

// ---------------------------------------------------------------------------------------------

describe('golden/db: withTenant() — the tenant comes only from the session', () => {
  it('no session → 401; password without TOTP → 401 (MFA is mandatory)', async () => {
    const anonymous = request(null, 'GET', `/api/users/${T.ownerH}`);
    const res = await getUser(anonymous.req, params({ id: T.ownerH }));
    expect(res.status).toBe(401);
    expectHeaders(res, anonymous.requestId);

    const half = newClient();
    await half.call('/sign-in/email', { email: people.ownerH.email, password: PASSWORD });
    const partial = request(half, 'GET', `/api/users/${T.ownerH}`);
    expect((await getUser(partial.req, params({ id: T.ownerH }))).status).toBe(401);
  });

  it('tenantId in body, query and header is ignored: the invitation lands in the session tenant', async () => {
    const r = request(
      people.ownerH.client ?? null,
      'POST',
      `/api/invitations?tenantId=${T.tenantI}`,
      {
        body: { ...invitePayload('smuggle'), tenantId: T.tenantI, tenant_id: T.tenantI },
        headers: { 'x-tenant-id': T.tenantI },
      },
    );
    const res = await createInvitationRoute(r.req, params({}));
    expect(res.status).toBe(201);
    const { invitationId } = (await body(res)) as { invitationId: string };
    const where = async (tenantId: string) =>
      inTenant(appPool, tenantId, async (c) => {
        const { rowCount } = await c.query('SELECT 1 FROM user_invitations WHERE id = $1', [
          invitationId,
        ]);
        return rowCount;
      });
    expect([await where(T.tenantH), await where(T.tenantI)]).toEqual([1, 0]);
  });

  it('a pooled connection with a leftover app.auth_user_id is RESET inside withTenant', async () => {
    const single = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
    try {
      await single.query("SELECT set_config('app.auth_user_id', $1, false)", [randomUUID()]);
      const handler = withTenant(
        async (_req, ctx) => {
          await ctx.requirePermission('user.read');
          const { rows } = await ctx.db.query<{ v: string; n: number }>(
            `SELECT coalesce(current_setting('app.auth_user_id', true), '') AS v,
                    (SELECT count(*)::int FROM users WHERE tenant_id <> app_tenant_id()) AS n`,
          );
          return NextResponse.json(rows[0]);
        },
        {
          appPool: () => single,
          allowedOrigin: () => BASE_URL,
          resolveIdentity: async () => ({
            tenantId: T.tenantH,
            userId: T.ownerH,
            authUserId: randomUUID(),
          }),
        },
      );
      const r = request(null, 'GET', '/api/test');
      const res = await handler(r.req, params({}));
      expect(await body(res)).toEqual({ v: '', n: 0 });
    } finally {
      await single.end();
    }
  });
});

describe('golden/db: CSRF — mutations only from our own origin (1.4)', () => {
  it('POST from another origin or without Origin → 403 forbidden_origin, nothing written', async () => {
    for (const origin of ['https://evil.example', null]) {
      const r = request(people.ownerH.client ?? null, 'POST', '/api/invitations', {
        body: invitePayload(`csrf-${origin ? 'evil' : 'none'}`),
      });
      if (origin) r.req.headers.set('origin', origin);
      else r.req.headers.delete('origin');
      const res = await createInvitationRoute(r.req, params({}));
      expect(res.status).toBe(403);
      expect(await body(res)).toEqual(apiErrorBody('forbidden_origin', r.requestId));
      expect(await auditRows(T.tenantH, r.requestId)).toEqual([]);
    }
  });

  it('a GET is not a mutation: no Origin needed', async () => {
    const r = request(people.ownerH.client ?? null, 'GET', `/api/users/${T.ownerH}`);
    r.req.headers.delete('origin');
    expect((await getUser(r.req, params({ id: T.ownerH }))).status).toBe(200);
  });
});

describe('golden/db: requirePermission() — 403 without detail', () => {
  it('a collector (no user.read) gets exactly {code, message_key, request_id} — no detail', async () => {
    const r = request(people.collectorH.client ?? null, 'GET', `/api/users/${T.collectorH}`);
    const res = await getUser(r.req, params({ id: T.collectorH }));
    expect(res.status).toBe(403);
    expect(await body(res)).toEqual(apiErrorBody('forbidden', r.requestId));
    expectHeaders(res, r.requestId);
  });

  it('a collector cannot invite (user.create) — 403, nothing written', async () => {
    const r = request(people.collectorH.client ?? null, 'POST', '/api/invitations', {
      body: invitePayload('by-collector'),
    });
    const res = await createInvitationRoute(r.req, params({}));
    expect(res.status).toBe(403);
    expect(await auditRows(T.tenantH, r.requestId)).toEqual([]);
  });

  it('an unknown permission key is a bug: 500 + error log, never a silent allow', async () => {
    const write = vi.spyOn(process.stdout, 'write');
    const handler = withTenant(async (_req, ctx) => {
      await ctx.requirePermission('nosuch.thing');
      return NextResponse.json({ ok: true });
    });
    const r = request(people.ownerH.client ?? null, 'GET', '/api/test');
    const res = await handler(r.req, params({}));
    const logged = write.mock.calls.map((call) => String(call[0])).join('');
    write.mockRestore();
    expect(res.status).toBe(500);
    expect(await body(res)).toEqual(apiErrorBody('internal', r.requestId));
    expect(logged).toContain('"event":"error.unknown_permission"');
    expect(logged).toContain(r.requestId);
  });

  it('fail closed: a handler that skips requirePermission() → 500 and rollback', async () => {
    const handler = withTenant(async (_req, ctx) => {
      await ctx.audit({ action: 'golden.unchecked', entityType: 'users', entityId: T.ownerH });
      return NextResponse.json({ ok: true });
    });
    const r = request(people.ownerH.client ?? null, 'POST', '/api/test');
    expect((await handler(r.req, params({}))).status).toBe(500);
    expect(await auditRows(T.tenantH, r.requestId)).toEqual([]);
  });

  it('fail closed: a successful mutation without audit() → 500 and rollback', async () => {
    const handler = withTenant(async (_req, ctx) => {
      await ctx.requirePermission('user.update');
      await ctx.db.query(`UPDATE users SET display_name = 'Changed' WHERE id = $1`, [T.ownerH]);
      return NextResponse.json({ ok: true });
    });
    const name = () =>
      inTenant(appPool, T.tenantH, async (c) => {
        const { rows } = await c.query<{ display_name: string }>(
          'SELECT display_name FROM users WHERE id = $1',
          [T.ownerH],
        );
        return rows[0]?.display_name;
      });
    const before = await name();
    const r = request(people.ownerH.client ?? null, 'POST', '/api/test');
    expect((await handler(r.req, params({}))).status).toBe(500);
    expect(await name()).toBe(before);
    expect(before).not.toBe('Changed');
  });
});

describe('golden/db: IDOR — another tenant’s id is 404, never 403', () => {
  it('GET /api/users/[id]: own tenant 200; other tenant and unknown id → identical 404', async () => {
    const client = people.ownerH.client ?? null;
    const own = request(client, 'GET', `/api/users/${T.collectorH}`);
    const ownRes = await getUser(own.req, params({ id: T.collectorH }));
    expect(ownRes.status).toBe(200);
    expect(await body(ownRes)).toMatchObject({ id: T.collectorH, status: 'active' });

    const foreign = request(client, 'GET', `/api/users/${T.ownerI}`);
    const foreignRes = await getUser(foreign.req, params({ id: T.ownerI }));
    const unknown = request(client, 'GET', `/api/users/${randomUUID()}`);
    const unknownRes = await getUser(unknown.req, params({ id: randomUUID() }));
    expect([foreignRes.status, unknownRes.status]).toEqual([404, 404]);
    expect(await body(foreignRes)).toEqual(apiErrorBody('not_found', foreign.requestId));
    expect(await body(unknownRes)).toEqual(apiErrorBody('not_found', unknown.requestId));
    expectHeaders(foreignRes, foreign.requestId);
  });

  it('POST /api/invitations/[id]/revoke with tenant I’s invitation id → 404, it stays pending', async () => {
    const inI = request(people.ownerI.client ?? null, 'POST', '/api/invitations', {
      body: invitePayload('idor-target'),
    });
    const created = await createInvitationRoute(inI.req, params({}));
    expect(created.status).toBe(201);
    const { invitationId } = (await body(created)) as { invitationId: string };

    const attack = request(
      people.ownerH.client ?? null,
      'POST',
      `/api/invitations/${invitationId}/revoke`,
    );
    const res = await revokeInvitation(attack.req, params({ id: invitationId }));
    expect(res.status).toBe(404);
    const status = await inTenant(appPool, T.tenantI, async (c) => {
      const { rows } = await c.query<{ status: string }>(
        'SELECT status FROM user_invitations WHERE id = $1',
        [invitationId],
      );
      return rows[0]?.status;
    });
    expect(status).toBe('pending');
    expect(await auditRows(T.tenantH, attack.requestId)).toEqual([]);
  });
});

describe('golden/db: every mutation writes an audit row with the request id', () => {
  it('POST /api/invitations → user.created + user_invitation.created; no e-mail in the snapshot', async () => {
    const r = request(people.ownerH.client ?? null, 'POST', '/api/invitations', {
      body: invitePayload('audited'),
    });
    const res = await createInvitationRoute(r.req, params({}));
    expect(res.status).toBe(201);
    expectHeaders(res, r.requestId);
    const rows = await auditRows(T.tenantH, r.requestId);
    expect(rows.map((x) => x.action)).toEqual(['user.created', 'user_invitation.created']);
    expect(JSON.stringify(rows)).not.toContain(email('audited'));
  });

  it('re-sending audits the revocation of the previous invitation', async () => {
    const first = request(people.ownerH.client ?? null, 'POST', '/api/invitations', {
      body: invitePayload('resent'),
    });
    expect((await createInvitationRoute(first.req, params({}))).status).toBe(201);
    const second = request(people.ownerH.client ?? null, 'POST', '/api/invitations', {
      body: invitePayload('resent'),
    });
    expect((await createInvitationRoute(second.req, params({}))).status).toBe(201);
    expect((await auditRows(T.tenantH, second.requestId)).map((x) => x.action)).toEqual([
      'user_invitation.created',
      'user_invitation.revoked',
    ]);
  });

  it('POST /api/invitations/[id]/revoke → user_invitation.revoked; a second revoke is 409', async () => {
    const c = people.ownerH.client ?? null;
    const made = request(c, 'POST', '/api/invitations', { body: invitePayload('to-revoke') });
    const { invitationId } = (await body(await createInvitationRoute(made.req, params({})))) as {
      invitationId: string;
    };
    const r = request(c, 'POST', `/api/invitations/${invitationId}/revoke`);
    const res = await revokeInvitation(r.req, params({ id: invitationId }));
    expect(res.status).toBe(200);
    expect((await auditRows(T.tenantH, r.requestId)).map((x) => x.action)).toEqual([
      'user_invitation.revoked',
    ]);
    const again = request(c, 'POST', `/api/invitations/${invitationId}/revoke`);
    const againRes = await revokeInvitation(again.req, params({ id: invitationId }));
    expect(againRes.status).toBe(409);
    expect(await body(againRes)).toEqual(apiErrorBody('not_pending', again.requestId));
  });
});

describe('golden/db: scope from user_roles decides what user.read reaches', () => {
  it('scope OWN sees only themselves (a colleague is 404); ORGANIZATION sees colleagues', async () => {
    const cfo = people.cfoH.client ?? null;
    const self = request(cfo, 'GET', `/api/users/${T.cfoH}`);
    expect((await getUser(self.req, params({ id: T.cfoH }))).status).toBe(200);
    const colleague = request(cfo, 'GET', `/api/users/${T.ownerH}`);
    expect((await getUser(colleague.req, params({ id: T.ownerH }))).status).toBe(404);

    const owner = request(people.ownerH.client ?? null, 'GET', `/api/users/${T.cfoH}`);
    expect((await getUser(owner.req, params({ id: T.cfoH }))).status).toBe(200);
  });
});

describe('golden/db: audit() redacts everything that is not plain P0', () => {
  it('P1 columns and unregistered keys become "[redacted]"', async () => {
    const after = await inTenant(appPool, T.tenantH, async (c) => {
      await writeAudit(
        c,
        { type: 'system' },
        {
          action: 'golden.redaction',
          entityType: 'users',
          entityId: T.ownerH,
          after: {
            email: 'person@example.test',
            display_name: 'Real Name',
            status: 'active',
            made_up: 1,
          },
        },
        null,
      );
      const { rows } = await c.query<{ after: Record<string, unknown> }>(
        `SELECT after FROM audit_log WHERE action = 'golden.redaction' ORDER BY occurred_at DESC LIMIT 1`,
      );
      return rows[0]?.after;
    });
    expect(after).toEqual({
      email: REDACTED,
      display_name: REDACTED,
      status: 'active',
      made_up: REDACTED,
    });
  });
});
