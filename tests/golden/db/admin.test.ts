import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

// Route runtime → TEST database; secrets random per run, never printed.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.BETTER_AUTH_SECRET = randomBytes(32).toString('base64');
process.env.BETTER_AUTH_URL = 'http://localhost:3000';
process.env.PII_MASTER_KEYS = `1:${randomBytes(32).toString('base64')}`;
// Turnstile is covered by captcha.test.ts; here it is off even if .env has keys.
process.env.TURNSTILE_SITE_KEY = '';
process.env.TURNSTILE_SECRET = '';

import { POST as decide } from '@/app/api/approvals/[id]/decision/route';
import { PUT as putSettings } from '@/app/api/settings/tenant/route';
import { POST as deactivate } from '@/app/api/users/[id]/deactivate/route';
import { POST as changeRole } from '@/app/api/users/[id]/role/route';
import { getAuth, getAuthPool } from '@/server/auth/better-auth';
import { permissionKeys } from '@/server/auth/permissions';
import { getAuthContext } from '@/server/auth/session';
import { grantsByRole, parsePermissionMatrix } from '@/server/permissions/matrix';
import { AuthClient, totp } from './auth-client';
import { appPool, closePools, inTenant, inTenantCommit, migratePool } from './helpers';

// Golden (never delete or skip) — task 1.5 admin functions: deactivation is a status (never
// DELETE) and ends access, a role change touching owner/admin waits for a second person
// (rule 11, four eyes), other role changes apply with audit, tenant settings change with audit +
// domain event, and permissions (not roles) decide. Own tenant L.

const BASE_URL = 'http://localhost:3000';
const TENANT = '0c100000-0000-4000-8000-0000000000c1';
const U = {
  owner1: '3c100000-0000-4000-8000-0000000000c1',
  owner2: '3c100000-0000-4000-8000-0000000000c2',
  admin: '3c100000-0000-4000-8000-0000000000c3',
  collector: '3c100000-0000-4000-8000-0000000000c4',
  cfo: '3c100000-0000-4000-8000-0000000000c5',
} as const;
const ROLES: Record<keyof typeof U, string> = {
  owner1: 'owner',
  owner2: 'owner',
  admin: 'admin',
  collector: 'collector',
  cfo: 'cfo',
};
const RUN = randomUUID().slice(0, 8);
const PASSWORD = `pw-${randomBytes(18).toString('base64url')}`;
const clients: Partial<Record<keyof typeof U, AuthClient>> = {};
const authIds: Partial<Record<keyof typeof U, string>> = {};
let ip = 0;

async function signIn(name: keyof typeof U): Promise<AuthClient> {
  const ctx = await getAuth().$context;
  const email = `${name}-${RUN}@admin-golden.example.test`;
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
  authIds[name] = user.id;
  await inTenantCommit(migratePool, TENANT, async (c) => {
    await c.query('UPDATE users SET auth_user_id = $1 WHERE id = $2', [user.id, U[name]]);
  });
  const client = new AuthClient(getAuth(), BASE_URL, `192.0.2.${100 + (ip += 1)}`);
  await client.call('/sign-in/email', { email, password: PASSWORD });
  const enabled = (await client.call('/two-factor/enable', { password: PASSWORD })).json as {
    totpURI: string;
  };
  expect(
    (await client.call('/two-factor/verify-totp', { code: totp(enabled.totpURI) })).status,
  ).toBe(200);
  return client;
}

function req(who: keyof typeof U, method: 'POST' | 'PUT', path: string, body?: unknown) {
  const requestId = randomUUID();
  const headers = new Headers(clients[who]?.headers());
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

async function rolesOf(userId: string) {
  return inTenant(appPool, TENANT, async (c) => {
    const { rows } = await c.query<{ key: string; scope: string }>(
      `SELECT r.key, ur.scope FROM user_roles ur JOIN roles r ON r.id = ur.role_id
       WHERE ur.user_id = $1 ORDER BY r.key`,
      [userId],
    );
    return rows;
  });
}

async function audited(requestId: string) {
  return inTenant(appPool, TENANT, async (c) => {
    const { rows } = await c.query<{ action: string }>(
      'SELECT action FROM audit_log WHERE request_id = $1 ORDER BY occurred_at, action',
      [requestId],
    );
    return rows.map((r) => r.action);
  });
}

async function resetMembers() {
  await inTenantCommit(migratePool, TENANT, async (c) => {
    await c.query(`UPDATE approval_requests SET status = 'cancelled' WHERE status = 'pending'`);
    for (const [name, userId] of Object.entries(U)) {
      const role = ROLES[name as keyof typeof U];
      await c.query(`UPDATE users SET status = 'active' WHERE id = $1`, [userId]);
      await c.query('DELETE FROM user_roles WHERE user_id = $1', [userId]);
      await c.query(
        `INSERT INTO user_roles (tenant_id, user_id, role_id, scope)
         SELECT $1, $2, id, $4 FROM roles WHERE key = $3`,
        [TENANT, userId, role, role === 'collector' ? 'OWN' : 'ORGANIZATION'],
      );
    }
  });
}

beforeAll(async () => {
  const grants = grantsByRole(
    parsePermissionMatrix(
      readFileSync(new URL('../../../docs/permissions.md', import.meta.url), 'utf8'),
    ),
  );
  await inTenantCommit(migratePool, null, async (c) => {
    for (const [cc, cur, tz] of [
      ['XX', 'EUR', 'UTC'],
      ['RS', 'RSD', 'Europe/Belgrade'],
    ]) {
      await c.query(
        `INSERT INTO jurisdiction_profiles (country_code, default_currency, default_locale, default_timezone)
         VALUES ($1, $2, 'en', $3) ON CONFLICT (country_code) DO NOTHING`,
        [cc, cur, tz],
      );
    }
  });
  await inTenantCommit(migratePool, TENANT, async (c) => {
    await c.query(
      `INSERT INTO tenants (id, slug, display_name, is_demo) VALUES ($1, 'golden-admin-l', 'Golden L', true)
       ON CONFLICT (id) DO NOTHING`,
      [TENANT],
    );
    await c.query(
      `INSERT INTO tenant_settings (tenant_id, timezone, default_currency, country_code)
       VALUES ($1, 'UTC', 'EUR', 'XX')
       ON CONFLICT (tenant_id) DO UPDATE SET timezone = 'UTC', default_currency = 'EUR',
         country_code = 'XX', default_locale = 'en'`,
      [TENANT],
    );
    for (const role of new Set([...Object.values(ROLES), 'finance_manager'])) {
      await c.query(
        `INSERT INTO roles (tenant_id, key, is_system) VALUES ($1, $2, true)
         ON CONFLICT (tenant_id, key) DO NOTHING`,
        [TENANT, role],
      );
      await c.query(
        `INSERT INTO role_permissions (tenant_id, role_id, permission_id)
         SELECT $1, r.id, p.id FROM roles r JOIN permissions p ON p.key = ANY($3::text[])
         WHERE r.key = $2 ON CONFLICT DO NOTHING`,
        [TENANT, role, grants.get(role) ?? []],
      );
    }
    for (const [name, userId] of Object.entries(U)) {
      await c.query(
        `INSERT INTO users (id, tenant_id, email, display_name, timezone, status)
         VALUES ($1, $2, $3, 'Golden Member', 'UTC', 'active') ON CONFLICT (id) DO NOTHING`,
        [userId, TENANT, `${name}@golden-admin-l.example.test`],
      );
    }
  });
  await resetMembers();
  for (const name of Object.keys(U) as (keyof typeof U)[]) clients[name] = await signIn(name);
});

afterEach(resetMembers);

afterAll(async () => {
  await inTenantCommit(migratePool, TENANT, async (c) => {
    await c.query('UPDATE users SET auth_user_id = NULL');
  });
  await migratePool.query(`DELETE FROM auth."user" WHERE email LIKE $1`, [
    `%-${RUN}@admin-golden.example.test`,
  ]);
  await migratePool.query(`DELETE FROM auth."rateLimit" WHERE key LIKE '192.0.2.1%'`);
  await closePools();
});

// ---------------------------------------------------------------------------------------------

describe('golden/db: deactivation is a status, never a DELETE, and ends access at once', () => {
  it('admin deactivates a collector: status disabled, audit + event, the collector loses the tenant', async () => {
    const r = req('admin', 'POST', `/api/users/${U.collector}/deactivate`);
    const res = await deactivate(r.req, params({ id: U.collector }));
    expect(res.status).toBe(200);
    expect(await audited(r.requestId)).toEqual(['user.deactivated']);
    const state = await inTenant(appPool, TENANT, async (c) => {
      const user = await c.query<{ status: string }>('SELECT status FROM users WHERE id = $1', [
        U.collector,
      ]);
      const event = await c.query(
        `SELECT 1 FROM domain_events WHERE event_type = 'user.deactivated' AND request_id = $1`,
        [r.requestId],
      );
      return { status: user.rows[0]?.status, events: event.rowCount };
    });
    expect(state).toEqual({ status: 'disabled', events: 1 });
    const ctx = await getAuthContext(
      getAuth(),
      getAuthPool(),
      clients.collector?.headers() ?? new Headers(),
    );
    expect(ctx.status).toBe('tenant_required');
  });

  it('not yourself (409 self_action); admin cannot touch an owner (403); unknown id → 404', async () => {
    const self = req('admin', 'POST', `/api/users/${U.admin}/deactivate`);
    const selfRes = await deactivate(self.req, params({ id: U.admin }));
    expect([selfRes.status, (await json(selfRes)).code]).toEqual([409, 'self_action']);

    const owner = req('admin', 'POST', `/api/users/${U.owner1}/deactivate`);
    expect((await deactivate(owner.req, params({ id: U.owner1 }))).status).toBe(403);

    const unknown = randomUUID();
    const missing = req('admin', 'POST', `/api/users/${unknown}/deactivate`);
    expect((await deactivate(missing.req, params({ id: unknown }))).status).toBe(404);
  });

  it('a collector has no user.update → 403, nothing changes', async () => {
    const r = req('collector', 'POST', `/api/users/${U.cfo}/deactivate`);
    expect((await deactivate(r.req, params({ id: U.cfo }))).status).toBe(403);
    expect(await audited(r.requestId)).toEqual([]);
  });
});

describe('golden/db: role changes — direct for ordinary roles, four eyes for privileged ones', () => {
  // Review S-06: cfo and collection_manager approve or oversee others — like owner/admin they
  // need a second administrator (before: collector → cfo applied at once).
  it('collector → cfo (privileged) becomes an approval request; nothing changes yet', async () => {
    const r = req('admin', 'POST', `/api/users/${U.collector}/role`, { roleKey: 'cfo' });
    const res = await changeRole(r.req, params({ id: U.collector }));
    const body = await json(res);
    expect([res.status, body.status]).toEqual([202, 'approval_required']);
    expect(await rolesOf(U.collector)).toEqual([{ key: 'collector', scope: 'OWN' }]);
    const reject = req('owner1', 'POST', `/api/approvals/${String(body.approvalId)}/decision`, {
      decision: 'reject',
      note: 'not now',
    });
    expect((await decide(reject.req, params({ id: String(body.approvalId) }))).status).toBe(200);
    expect(await rolesOf(U.collector)).toEqual([{ key: 'collector', scope: 'OWN' }]);
  });

  it('collector → finance_manager (not privileged) applies at once, keeps the narrow scope, audited', async () => {
    const r = req('admin', 'POST', `/api/users/${U.collector}/role`, {
      roleKey: 'finance_manager',
    });
    const res = await changeRole(r.req, params({ id: U.collector }));
    expect([res.status, (await json(res)).status]).toEqual([200, 'applied']);
    expect(await rolesOf(U.collector)).toEqual([{ key: 'finance_manager', scope: 'OWN' }]);
    expect(await audited(r.requestId)).toEqual(['user_role.changed']);
  });

  it('cfo → admin becomes an approval request; the requester cannot decide it; another owner can', async () => {
    const r = req('owner1', 'POST', `/api/users/${U.cfo}/role`, { roleKey: 'admin' });
    const res = await changeRole(r.req, params({ id: U.cfo }));
    const body = await json(res);
    expect([res.status, body.status]).toEqual([202, 'approval_required']);
    expect(await rolesOf(U.cfo)).toEqual([{ key: 'cfo', scope: 'ORGANIZATION' }]);
    const approvalId = String(body.approvalId);

    const own = req('owner1', 'POST', `/api/approvals/${approvalId}/decision`, {
      decision: 'approve',
    });
    expect((await decide(own.req, params({ id: approvalId }))).status).toBe(403);

    const collector = req('collector', 'POST', `/api/approvals/${approvalId}/decision`, {
      decision: 'approve',
    });
    expect((await decide(collector.req, params({ id: approvalId }))).status).toBe(403);

    const checker = req('owner2', 'POST', `/api/approvals/${approvalId}/decision`, {
      decision: 'approve',
    });
    const decided = await decide(checker.req, params({ id: approvalId }));
    expect([decided.status, (await json(decided)).status]).toEqual([200, 'approved']);
    expect(await rolesOf(U.cfo)).toEqual([{ key: 'admin', scope: 'ORGANIZATION' }]);
    expect(await audited(checker.requestId)).toEqual([
      'approval_request.approved',
      'user_role.changed',
    ]);

    const again = req('owner2', 'POST', `/api/approvals/${approvalId}/decision`, {
      decision: 'reject',
    });
    expect((await json(await decide(again.req, params({ id: approvalId })))).code).toBe(
      'not_pending',
    );
  });

  it('an admin can neither request nor approve an owner promotion', async () => {
    const byAdmin = req('admin', 'POST', `/api/users/${U.cfo}/role`, { roleKey: 'owner' });
    expect((await changeRole(byAdmin.req, params({ id: U.cfo }))).status).toBe(403);

    const r = req('owner1', 'POST', `/api/users/${U.cfo}/role`, { roleKey: 'owner' });
    const approvalId = String(
      (await json(await changeRole(r.req, params({ id: U.cfo })))).approvalId,
    );
    const adminDecides = req('admin', 'POST', `/api/approvals/${approvalId}/decision`, {
      decision: 'approve',
    });
    expect((await decide(adminDecides.req, params({ id: approvalId }))).status).toBe(403);
    expect(await rolesOf(U.cfo)).toEqual([{ key: 'cfo', scope: 'ORGANIZATION' }]);
  });

  it('the database itself refuses requester = decider (approval_requests_four_eyes)', async () => {
    const r = req('owner1', 'POST', `/api/users/${U.collector}/role`, { roleKey: 'admin' });
    const approvalId = String(
      (await json(await changeRole(r.req, params({ id: U.collector })))).approvalId,
    );
    const state = await inTenant(appPool, TENANT, async (c) => {
      await c.query('SAVEPOINT s');
      try {
        await c.query(
          `UPDATE approval_requests SET status = 'approved', decided_by = $2, decided_at = now() WHERE id = $1`,
          [approvalId, U.owner1],
        );
        return 'OK';
      } catch (error) {
        return (error as { code?: string }).code;
      }
    });
    expect(state).toBe('23514');
  });
});

describe('golden/db: tenant settings', () => {
  it('owner changes time zone and currency: audit before/after + one domain event', async () => {
    const r = req('owner1', 'PUT', '/api/settings/tenant', {
      defaultLocale: 'sr-Latn',
      timezone: 'Europe/Belgrade',
      defaultCurrency: 'RSD',
      countryCode: 'RS',
    });
    const res = await putSettings(r.req, params({}));
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ timezone: 'Europe/Belgrade', defaultCurrency: 'RSD' });
    const trail = await inTenant(appPool, TENANT, async (c) => {
      const audit = await c.query<{
        before: Record<string, string>;
        after: Record<string, string>;
      }>(
        `SELECT before, after FROM audit_log WHERE request_id = $1 AND action = 'tenant_settings.updated'`,
        [r.requestId],
      );
      const events = await c.query<{ payload: { changed: string[] } }>(
        `SELECT payload FROM domain_events WHERE request_id = $1 AND event_type = 'tenant_settings.updated'`,
        [r.requestId],
      );
      return { audit: audit.rows, events: events.rows };
    });
    expect(trail.audit).toEqual([
      {
        before: {
          default_locale: 'en',
          timezone: 'UTC',
          default_currency: 'EUR',
          country_code: 'XX',
        },
        after: {
          default_locale: 'sr-Latn',
          timezone: 'Europe/Belgrade',
          default_currency: 'RSD',
          country_code: 'RS',
        },
      },
    ]);
    expect(trail.events.map((e) => e.payload.changed.sort())).toEqual([
      ['country_code', 'default_currency', 'default_locale', 'timezone'],
    ]);
    await inTenantCommit(migratePool, TENANT, async (c) => {
      await c.query(
        `UPDATE tenant_settings SET timezone = 'UTC', default_currency = 'EUR', country_code = 'XX', default_locale = 'en'`,
      );
    });
  });

  it('settings.read without settings.manage (cfo) → 403; an unknown zone or country → 400', async () => {
    const valid = {
      defaultLocale: 'en',
      timezone: 'UTC',
      defaultCurrency: 'EUR',
      countryCode: 'XX',
    };
    const cfo = req('cfo', 'PUT', '/api/settings/tenant', valid);
    expect((await putSettings(cfo.req, params({}))).status).toBe(403);
    for (const bad of [
      { ...valid, timezone: 'Mars/Olympus' },
      { ...valid, defaultCurrency: 'XYZ' },
      { ...valid, countryCode: 'ZZ' },
    ]) {
      const r = req('owner1', 'PUT', '/api/settings/tenant', bad);
      const res = await putSettings(r.req, params({}));
      expect([res.status, (await json(res)).code]).toEqual([400, 'invalid_request']);
    }
  });
});

describe('golden/db: navigation follows permissions, not role names', () => {
  it('owner holds user.read + settings.read; a collector holds neither', async () => {
    const keys = async (userId: string) =>
      inTenant(appPool, TENANT, async (c) => permissionKeys(c, userId));
    const owner = await keys(U.owner1);
    const collector = await keys(U.collector);
    expect(['user.read', 'settings.read'].every((k) => owner.has(k))).toBe(true);
    expect(['user.read', 'settings.read'].some((k) => collector.has(k))).toBe(false);
  });
});
