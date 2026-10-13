import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureFixtures, FX } from './fixtures';
import { appPool, closePools, inTenant, inTenantCommit, migratePool, sqlState } from './helpers';

// Golden (never delete or skip) — security review S-03:
//   - credentials in schema auth (session tokens, password hashes, TOTP secrets) are invisible
//     to vigor_app INSIDE a tenant transaction — every tenant route runs there — while Better Auth
//     (own pool, no tenant) keeps working;
//   - auth.session."activeTenantId", the only tenant source of withTenant(), can only point at an
//     ACTIVE membership of the session's person — checked by the database on every write.

// Own tenant: a fixture tenant's member count is part of other golden tests.
const TENANT = '0d200000-0000-4000-8000-0000000000d2';
const AUTH_USER = randomUUID();
const MEMBER = randomUUID();
const TOKEN = `golden-${randomBytes(16).toString('hex')}`;
let sessionId = '';

beforeAll(async () => {
  await ensureFixtures();
  await inTenantCommit(migratePool, TENANT, async (c) => {
    await c.query(
      `INSERT INTO tenants (id, slug, display_name, is_demo) VALUES ($1, 'golden-auth-isolation', 'Golden', true)
       ON CONFLICT (id) DO NOTHING`,
      [TENANT],
    );
    await c.query(
      `INSERT INTO tenant_settings (tenant_id, timezone, default_currency, country_code)
       VALUES ($1, 'UTC', 'EUR', 'XX') ON CONFLICT (tenant_id) DO NOTHING`,
      [TENANT],
    );
  });
  await migratePool.query(
    `INSERT INTO auth."user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
     VALUES ($1, 'Golden Isolation', $2, true, now(), now())`,
    [AUTH_USER, `isolation-${AUTH_USER.slice(0, 8)}@golden.example.test`],
  );
  await inTenantCommit(migratePool, TENANT, async (c) => {
    await c.query(
      `INSERT INTO users (id, tenant_id, email, display_name, timezone, status, auth_user_id)
       VALUES ($1, $2, $3, 'Golden Isolation', 'UTC', 'active', $4)`,
      [MEMBER, TENANT, `isolation-${MEMBER.slice(0, 8)}@golden.example.test`, AUTH_USER],
    );
  });
  const s = await migratePool.query<{ id: string }>(
    `INSERT INTO auth."session" ("expiresAt", token, "updatedAt", "userId", "activeTenantId")
     VALUES (now() + interval '1 hour', $1, now(), $2, $3) RETURNING id`,
    [TOKEN, AUTH_USER, TENANT],
  );
  sessionId = s.rows[0]?.id ?? '';
});

afterAll(async () => {
  await migratePool.query(`DELETE FROM auth."session" WHERE "userId" = $1`, [AUTH_USER]);
  await inTenantCommit(migratePool, TENANT, async (c) => {
    await c.query('DELETE FROM users WHERE id = $1', [MEMBER]);
  });
  await migratePool.query(`DELETE FROM auth."user" WHERE id = $1`, [AUTH_USER]);
  await closePools();
});

describe('golden/db: auth credentials are out of reach inside a tenant transaction (S-03)', () => {
  it('a tenant transaction sees no session, account, two-factor or user row', async () => {
    const inside = await inTenant(appPool, TENANT, async (c) => {
      const out: Record<string, number> = {};
      for (const table of ['session', 'account', 'twoFactor', 'verification', 'user']) {
        out[table] = (await c.query(`SELECT 1 FROM auth."${table}"`)).rowCount ?? 0;
      }
      out.token =
        (await c.query(`SELECT 1 FROM auth."session" WHERE token = $1`, [TOKEN])).rowCount ?? 0;
      out.updated =
        (await c.query(`UPDATE auth."session" SET "updatedAt" = now() WHERE token = $1`, [TOKEN]))
          .rowCount ?? 0;
      return out;
    });
    expect(inside).toEqual({
      session: 0,
      account: 0,
      twoFactor: 0,
      verification: 0,
      user: 0,
      token: 0,
      updated: 0,
    });
  });

  it('outside a tenant transaction (Better Auth’s own pool) the session is found as before', async () => {
    const outside = await inTenant(appPool, null, (c) =>
      c.query(`SELECT id FROM auth."session" WHERE token = $1`, [TOKEN]),
    );
    expect(outside.rows).toEqual([{ id: sessionId }]);
  });
});

describe('golden/db: a session’s active tenant is an active membership (S-03)', () => {
  const setActive = (tenantId: string) =>
    inTenant(appPool, null, (c) =>
      c.query(`UPDATE auth."session" SET "activeTenantId" = $2 WHERE id = $1`, [
        sessionId,
        tenantId,
      ]),
    );

  it('switching to a tenant the person is not a member of is refused by the database', async () => {
    expect(await sqlState(setActive(FX.tenantB))).toBe('42501');
    expect(await sqlState(setActive(TENANT))).toBe('OK');
    expect(
      await sqlState(
        inTenant(appPool, null, (c) =>
          c.query(
            `INSERT INTO auth."session" ("expiresAt", token, "updatedAt", "userId", "activeTenantId")
             VALUES (now() + interval '1 hour', $1, now(), $2, $3)`,
            [`golden-${randomUUID()}`, AUTH_USER, FX.tenantB],
          ),
        ),
      ),
    ).toBe('42501');
  });

  it('a disabled membership cannot be chosen any more', async () => {
    await inTenantCommit(migratePool, TENANT, async (c) => {
      await c.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [MEMBER]);
    });
    try {
      await inTenant(appPool, null, (c) =>
        c.query(`UPDATE auth."session" SET "activeTenantId" = NULL WHERE id = $1`, [sessionId]),
      );
      expect(
        await sqlState(
          inTenant(appPool, null, async (c) => {
            await c.query(`UPDATE auth."session" SET "activeTenantId" = NULL WHERE id = $1`, [
              sessionId,
            ]);
            await c.query(`UPDATE auth."session" SET "activeTenantId" = $2 WHERE id = $1`, [
              sessionId,
              TENANT,
            ]);
          }),
        ),
      ).toBe('42501');
    } finally {
      await inTenantCommit(migratePool, TENANT, async (c) => {
        await c.query(`UPDATE users SET status = 'active' WHERE id = $1`, [MEMBER]);
      });
    }
  });
});
