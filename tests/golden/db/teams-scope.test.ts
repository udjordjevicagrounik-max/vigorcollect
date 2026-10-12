import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Route runtime → TEST database; Turnstile off here (captcha.test.ts covers it).
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.BETTER_AUTH_SECRET = randomBytes(32).toString('base64');
process.env.BETTER_AUTH_URL = 'http://localhost:3000';
process.env.PII_MASTER_KEYS = `1:${randomBytes(32).toString('base64')}`;
process.env.TURNSTILE_SITE_KEY = '';
process.env.TURNSTILE_SECRET = '';

import { POST as decide } from '@/app/api/approvals/[id]/decision/route';
import { POST as propose } from '@/app/api/approvals/route';
import { GET as getCustomer } from '@/app/api/customers/[id]/route';
import { GET as listCustomers } from '@/app/api/customers/route';
import { PUT as setLead } from '@/app/api/teams/[id]/lead/route';
import { POST as addMember } from '@/app/api/teams/[id]/members/route';
import { getAuth } from '@/server/auth/better-auth';
import { permissionKeys } from '@/server/auth/permissions';
import { grantsByRole, parsePermissionMatrix } from '@/server/permissions/matrix';
import { AuthClient, totp } from './auth-client';
import { appPool, closePools, inTenant, inTenantCommit, migratePool, sqlState } from './helpers';

// Golden (never delete or skip) — task 1.6: scope enforcement through scopeFilter() (OWN /
// TEAM / ORGANIZATION) on customers, teams isolated per tenant, one primary team per person,
// lead changes audited, and role-matrix changes only through maker-checker (rule 11).
// Own tenants M (data) and N (isolation).

const BASE_URL = 'http://localhost:3000';
const TM = '0d100000-0000-4000-8000-0000000000d1';
const TN = '0d200000-0000-4000-8000-0000000000d2';
const U = {
  owner: '3d100000-0000-4000-8000-0000000000d1',
  admin: '3d100000-0000-4000-8000-0000000000d2',
  ownA: '3d100000-0000-4000-8000-0000000000d3', // collector, OWN, team A
  teamA: '3d100000-0000-4000-8000-0000000000d4', // collector, TEAM, team A
  teamB: '3d100000-0000-4000-8000-0000000000d5', // collector, TEAM, team B
  loner: '3d100000-0000-4000-8000-0000000000d6', // collector, no team
} as const;
type Who = keyof typeof U;
const SETUP: Record<Who, [role: string, scope: string]> = {
  owner: ['owner', 'ORGANIZATION'],
  admin: ['admin', 'ORGANIZATION'],
  ownA: ['collector', 'OWN'],
  teamA: ['collector', 'TEAM'],
  teamB: ['collector', 'TEAM'],
  loner: ['collector', 'TEAM'],
};
const TEAM = {
  a: '5d100000-0000-4000-8000-0000000000d1',
  b: '5d100000-0000-4000-8000-0000000000d2',
  n: '5d200000-0000-4000-8000-0000000000d2',
} as const;
const C = {
  ofOwnA: '6d100000-0000-4000-8000-0000000000d1',
  ofTeamB: '6d100000-0000-4000-8000-0000000000d2',
  teamOwnedA: '6d100000-0000-4000-8000-0000000000d3',
  unowned: '6d100000-0000-4000-8000-0000000000d4',
} as const;
const RUN = randomUUID().slice(0, 8);
const PASSWORD = `pw-${randomBytes(18).toString('base64url')}`;
const clients: Partial<Record<Who, AuthClient>> = {};
let ip = 0;

async function signIn(who: Who): Promise<AuthClient> {
  const ctx = await getAuth().$context;
  const email = `${who}-${RUN}@scope-golden.example.test`;
  const user = await ctx.internalAdapter.createUser(
    { email, name: 'Golden', emailVerified: true },
    { method: 'admin' },
  );
  await ctx.internalAdapter.linkAccount({
    userId: user.id,
    providerId: 'credential',
    accountId: user.id,
    password: await ctx.password.hash(PASSWORD),
  });
  await inTenantCommit(migratePool, TM, async (c) => {
    await c.query('UPDATE users SET auth_user_id = $1 WHERE id = $2', [user.id, U[who]]);
  });
  const client = new AuthClient(getAuth(), BASE_URL, `192.0.2.${200 + (ip += 1)}`);
  await client.call('/sign-in/email', { email, password: PASSWORD });
  const enabled = (await client.call('/two-factor/enable', { password: PASSWORD })).json as {
    totpURI: string;
  };
  expect(
    (await client.call('/two-factor/verify-totp', { code: totp(enabled.totpURI) })).status,
  ).toBe(200);
  return client;
}

function req(who: Who, method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown) {
  const headers = new Headers(clients[who]?.headers());
  const requestId = randomUUID();
  headers.set('x-request-id', requestId);
  headers.set('origin', BASE_URL);
  if (body !== undefined) headers.set('content-type', 'application/json');
  return {
    requestId,
    req: new NextRequest(`${BASE_URL}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  };
}
const params = <P>(p: P) => ({ params: Promise.resolve(p) });
const json = async (res: Response) => JSON.parse(await res.text()) as Record<string, unknown>;

async function visible(who: Who): Promise<string[]> {
  const r = req(who, 'GET', '/api/customers');
  const res = await listCustomers(r.req, params({}));
  expect(res.status).toBe(200);
  const body = (await json(res)) as { customers: { id: string }[] };
  return body.customers
    .map((c) => c.id)
    .filter((id) => (Object.values(C) as string[]).includes(id))
    .sort();
}

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
    for (const [i, id] of Object.values(C).entries()) {
      await c.query(
        `INSERT INTO legal_entities (id, country_code, tax_id, legal_name, normalized_name, timezone)
         VALUES ($1, 'XX', $2, $2, lower($2), 'UTC') ON CONFLICT (id) DO NOTHING`,
        [id.replace(/^6d/, '1e'), `GOLDEN-SCOPE-${i}`],
      );
    }
  });
  for (const [tenant, slug] of [
    [TM, 'golden-scope-m'],
    [TN, 'golden-scope-n'],
  ] as const) {
    await inTenantCommit(migratePool, tenant, async (c) => {
      await c.query(
        `INSERT INTO tenants (id, slug, display_name, is_demo) VALUES ($1, $2, $2, true) ON CONFLICT (id) DO NOTHING`,
        [tenant, slug],
      );
      await c.query(
        `INSERT INTO tenant_settings (tenant_id, timezone, default_currency, country_code)
         VALUES ($1, 'UTC', 'EUR', 'XX') ON CONFLICT (tenant_id) DO NOTHING`,
        [tenant],
      );
    });
  }
  await inTenantCommit(migratePool, TN, async (c) => {
    await c.query(
      `INSERT INTO teams (id, tenant_id, key, name) VALUES ($1, $2, 'n-team', 'N team') ON CONFLICT (id) DO NOTHING`,
      [TEAM.n, TN],
    );
  });
  await inTenantCommit(migratePool, TM, async (c) => {
    for (const role of ['owner', 'admin', 'collector']) {
      await c.query(
        `INSERT INTO roles (tenant_id, key, is_system) VALUES ($1, $2, true) ON CONFLICT (tenant_id, key) DO NOTHING`,
        [TM, role],
      );
      await c.query(
        'DELETE FROM role_permissions WHERE role_id = (SELECT id FROM roles WHERE key = $1)',
        [role],
      );
      await c.query(
        `INSERT INTO role_permissions (tenant_id, role_id, permission_id)
         SELECT $1, r.id, p.id FROM roles r JOIN permissions p ON p.key = ANY($3::text[])
         WHERE r.key = $2 ON CONFLICT DO NOTHING`,
        [TM, role, grants.get(role) ?? []],
      );
    }
    for (const [who, userId] of Object.entries(U) as [Who, string][]) {
      const [role, scope] = SETUP[who];
      await c.query(
        `INSERT INTO users (id, tenant_id, email, display_name, timezone, status)
         VALUES ($1, $2, $3, $4, 'UTC', 'active') ON CONFLICT (id) DO NOTHING`,
        [userId, TM, `${who}@golden-scope-m.example.test`, `Golden ${who}`],
      );
      await c.query('DELETE FROM user_roles WHERE user_id = $1', [userId]);
      await c.query(
        `INSERT INTO user_roles (tenant_id, user_id, role_id, scope) SELECT $1, $2, id, $4 FROM roles WHERE key = $3`,
        [TM, userId, role, scope],
      );
    }
    await c.query('DELETE FROM team_members');
    for (const [id, key] of [
      [TEAM.a, 'team-a'],
      [TEAM.b, 'team-b'],
    ] as const) {
      await c.query(
        `INSERT INTO teams (id, tenant_id, key, name) VALUES ($1, $2, $3, $3)
         ON CONFLICT (id) DO UPDATE SET lead_user_id = NULL`,
        [id, TM, key],
      );
    }
    for (const [team, user] of [
      [TEAM.a, U.ownA],
      [TEAM.a, U.teamA],
      [TEAM.b, U.teamB],
    ] as const) {
      await c.query('INSERT INTO team_members (tenant_id, team_id, user_id) VALUES ($1, $2, $3)', [
        TM,
        team,
        user,
      ]);
    }
    for (const [id, ownerUser, ownerTeam] of [
      [C.ofOwnA, U.ownA, null],
      [C.ofTeamB, U.teamB, null],
      [C.teamOwnedA, null, TEAM.a],
      [C.unowned, null, null],
    ] as const) {
      await c.query(
        `INSERT INTO customers (id, tenant_id, legal_entity_id, display_name, owner_user_id, owner_team_id)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO UPDATE
           SET owner_user_id = EXCLUDED.owner_user_id, owner_team_id = EXCLUDED.owner_team_id`,
        [id, TM, id.replace(/^6d/, '1e'), `Customer ${id.slice(-2)}`, ownerUser, ownerTeam],
      );
    }
  });
  for (const who of Object.keys(U) as Who[]) clients[who] = await signIn(who);
});

afterAll(async () => {
  await inTenantCommit(migratePool, TM, async (c) => {
    await c.query(`UPDATE approval_requests SET status = 'cancelled' WHERE status = 'pending'`);
    await c.query('UPDATE users SET auth_user_id = NULL');
  });
  await migratePool.query(`DELETE FROM auth."user" WHERE email LIKE $1`, [
    `%-${RUN}@scope-golden.example.test`,
  ]);
  await migratePool.query(`DELETE FROM auth."rateLimit" WHERE key LIKE '192.0.2.2%'`);
  await closePools();
});

// ---------------------------------------------------------------------------------------------

describe('golden/db: scope on customers (scopeFilter)', () => {
  it('OWN sees only own customers; a colleague’s customer by id is 404', async () => {
    expect(await visible('ownA')).toEqual([C.ofOwnA]);
    const r = req('ownA', 'GET', `/api/customers/${C.ofTeamB}`);
    expect((await getCustomer(r.req, params({ id: C.ofTeamB }))).status).toBe(404);
  });

  it('TEAM sees teammates’ and the team’s customers, never another team’s', async () => {
    expect(await visible('teamA')).toEqual([C.ofOwnA, C.teamOwnedA].sort());
    expect(await visible('teamB')).toEqual([C.ofTeamB]);
    const r = req('teamA', 'GET', `/api/customers/${C.ofTeamB}`);
    expect((await getCustomer(r.req, params({ id: C.ofTeamB }))).status).toBe(404);
  });

  it('TEAM without a team behaves as OWN; unowned customers need ORGANIZATION', async () => {
    expect(await visible('loner')).toEqual([]);
    expect(await visible('owner')).toEqual(Object.values(C).sort());
  });
});

describe('golden/db: teams', () => {
  it('tenant M does not see tenant N’s team', async () => {
    const seen = await inTenant(
      appPool,
      TM,
      async (c) => (await c.query('SELECT 1 FROM teams WHERE id = $1', [TEAM.n])).rowCount,
    );
    expect(seen).toBe(0);
  });

  it('one primary team per person — service (409) and database (23505)', async () => {
    const r = req('admin', 'POST', `/api/teams/${TEAM.b}/members`, { userId: U.ownA });
    expect((await addMember(r.req, params({ id: TEAM.b }))).status).toBe(409);
    const direct = await inTenant(appPool, TM, (c) =>
      sqlState(
        c.query('INSERT INTO team_members (tenant_id, team_id, user_id) VALUES ($1, $2, $3)', [
          TM,
          TEAM.b,
          U.ownA,
        ]),
      ),
    );
    expect(direct).toBe('23505');
  });

  it('lead must be a member; a lead change writes audit + team.lead_changed', async () => {
    const outsider = req('admin', 'PUT', `/api/teams/${TEAM.a}/lead`, { userId: U.teamB });
    expect((await setLead(outsider.req, params({ id: TEAM.a }))).status).toBe(409);

    const r = req('admin', 'PUT', `/api/teams/${TEAM.a}/lead`, { userId: U.teamA });
    expect((await setLead(r.req, params({ id: TEAM.a }))).status).toBe(200);
    const trail = await inTenant(appPool, TM, async (c) => ({
      audit: (
        await c.query<{ after: unknown }>(`SELECT after FROM audit_log WHERE request_id = $1`, [
          r.requestId,
        ])
      ).rows,
      events: (
        await c.query(
          `SELECT 1 FROM domain_events WHERE request_id = $1 AND event_type = 'team.lead_changed'`,
          [r.requestId],
        )
      ).rowCount,
    }));
    expect(trail.audit).toEqual([{ after: { lead_user_id: U.teamA } }]);
    expect(trail.events).toBe(1);
  });

  it('a collector cannot manage teams (403)', async () => {
    const r = req('teamA', 'PUT', `/api/teams/${TEAM.a}/lead`, { userId: null });
    expect((await setLead(r.req, params({ id: TEAM.a }))).status).toBe(403);
  });
});

describe('golden/db: role matrix changes only through maker-checker (rule 11)', () => {
  const change = { roleKey: 'collector', permissionKey: 'customer.export', grant: true };

  it('the old matrix holds until another person approves; the requester cannot decide', async () => {
    const proposed = req('owner', 'POST', '/api/approvals', change);
    const res = await propose(proposed.req, params({}));
    expect(res.status).toBe(202);
    const approvalId = String((await json(res)).approvalId);
    const holds = async () =>
      inTenant(appPool, TM, async (c) => (await permissionKeys(c, U.ownA)).has('customer.export'));
    expect(await holds()).toBe(false);

    const own = req('owner', 'POST', `/api/approvals/${approvalId}/decision`, {
      decision: 'approve',
    });
    expect((await decide(own.req, params({ id: approvalId }))).status).toBe(403);
    expect(await holds()).toBe(false);

    const checker = req('admin', 'POST', `/api/approvals/${approvalId}/decision`, {
      decision: 'approve',
      note: 'needed for month-end export',
    });
    expect((await decide(checker.req, params({ id: approvalId }))).status).toBe(200);
    expect(await holds()).toBe(true);
    const audit = await inTenant(appPool, TM, async (c) =>
      (
        await c.query<{ action: string }>(
          'SELECT action FROM audit_log WHERE request_id = $1 ORDER BY action',
          [checker.requestId],
        )
      ).rows.map((r) => r.action),
    );
    expect(audit).toEqual(['approval_request.approved', 'role_permission.granted']);

    // Clean the grant up through the same flow.
    const back = req('owner', 'POST', '/api/approvals', { ...change, grant: false });
    const backId = String((await json(await propose(back.req, params({})))).approvalId);
    const ok = req('admin', 'POST', `/api/approvals/${backId}/decision`, { decision: 'approve' });
    expect((await decide(ok.req, params({ id: backId }))).status).toBe(200);
    expect(await holds()).toBe(false);
  });

  it('admin cannot propose (no approval.create); the owner role is not changeable here', async () => {
    const byAdmin = req('admin', 'POST', '/api/approvals', change);
    expect((await propose(byAdmin.req, params({}))).status).toBe(403);
    const ownerRole = req('owner', 'POST', '/api/approvals', {
      ...change,
      roleKey: 'owner',
      grant: false,
    });
    const res = await propose(ownerRole.req, params({}));
    expect([res.status, (await json(res)).code]).toEqual([409, 'unsupported']);
  });
});
