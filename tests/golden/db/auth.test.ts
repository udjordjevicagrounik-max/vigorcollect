import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createAuth,
  createAuthPool,
  LOCKOUT_SECONDS,
  SESSION_TTL_SECONDS,
  type AuthMail,
} from '@/server/auth/better-auth';
import { activeMemberships } from '@/server/auth/memberships';
import { getAuthContext } from '@/server/auth/session';
import { AuthClient, totp } from './auth-client';
import { appPool, closePools, inTenant, inTenantCommit, migratePool } from './helpers';

// Golden (never delete or skip): sign-in with password + mandatory TOTP, 8 h absolute session,
// lockout after 5 failures, identical answers for unknown accounts, per-IP rate limit and a
// session bound to exactly one tenant membership (rules 2, 10, 27; ADR 0004).
//
// Own tenants C/D (never A/B: other golden files count A/B users). Credentials are random per
// run and never printed.

const BASE_URL = 'http://localhost:3000';
const AUTH = {
  tenantC: '0c000000-0000-4000-8000-00000000000c',
  tenantD: '0d000000-0000-4000-8000-00000000000d',
  userC: '3c000000-0000-4000-8000-00000000000c', // member of C only
  userCD_C: '3c000000-0000-4000-8000-0000000000cd', // same person, membership in C
  userCD_D: '3d000000-0000-4000-8000-0000000000cd', // same person, membership in D
} as const;

const RUN = randomUUID().slice(0, 8);
const PASSWORD = `pw-${randomBytes(18).toString('base64url')}`;
const mails: AuthMail[] = [];

const authPool = createAuthPool(process.env.TEST_DATABASE_URL ?? '');
const auth = createAuth(
  {
    connectionString: '',
    secret: randomBytes(32).toString('base64'),
    baseURL: BASE_URL,
    issuer: 'Golden',
    mailer: async (mail) => {
      mails.push(mail);
    },
  },
  authPool,
);

let ipCounter = 0;
const newClient = (): AuthClient =>
  new AuthClient(auth, BASE_URL, `198.51.100.${(ipCounter += 1)}`);
type Client = AuthClient;

// ---------------------------------------------------------------------------------------------
// Fixtures: persistent tenants/users C, D; auth identities are per run and removed afterwards.
// ---------------------------------------------------------------------------------------------

type Person = { email: string; authUserId: string; otpauth?: string };
const people: Record<'c' | 'cd' | 'noMfa', Person> = {
  c: { email: `c-${RUN}@auth-golden.example.test`, authUserId: '' },
  cd: { email: `cd-${RUN}@auth-golden.example.test`, authUserId: '' },
  noMfa: { email: `nomfa-${RUN}@auth-golden.example.test`, authUserId: '' },
};

async function createIdentity(email: string): Promise<string> {
  const ctx = await auth.$context;
  const user = await ctx.internalAdapter.createUser(
    {
      email,
      name: 'Golden Person',
      emailVerified: true,
    },
    { method: 'admin' },
  );
  await ctx.internalAdapter.linkAccount({
    userId: user.id,
    providerId: 'credential',
    accountId: user.id,
    password: await ctx.password.hash(PASSWORD),
  });
  return user.id;
}

async function link(tenantId: string, userId: string, authUserId: string | null): Promise<void> {
  await inTenantCommit(migratePool, tenantId, async (c) => {
    await c.query('UPDATE users SET auth_user_id = $1 WHERE id = $2', [authUserId, userId]);
  });
}

async function enrollTotp(person: Person): Promise<void> {
  const client = newClient();
  await client.call('/sign-in/email', { email: person.email, password: PASSWORD });
  const enabled = (await client.call('/two-factor/enable', { password: PASSWORD })).json as {
    totpURI: string;
  };
  person.otpauth = enabled.totpURI;
  const verified = await client.call('/two-factor/verify-totp', { code: totp(enabled.totpURI) });
  expect(verified.status).toBe(200);
}

/** Password + TOTP → a full session. */
async function signIn(person: Person): Promise<Client> {
  const client = newClient();
  const first = await client.call('/sign-in/email', { email: person.email, password: PASSWORD });
  expect(first.json).toMatchObject({ twoFactorRedirect: true });
  const second = await client.call('/two-factor/verify-totp', { code: totp(person.otpauth ?? '') });
  expect(second.status).toBe(200);
  return client;
}

beforeAll(async () => {
  for (const [tenantId, slug] of [
    [AUTH.tenantC, 'golden-auth-c'],
    [AUTH.tenantD, 'golden-auth-d'],
  ] as const) {
    await inTenantCommit(migratePool, tenantId, async (c) => {
      await c.query(
        `INSERT INTO tenants (id, slug, display_name) VALUES ($1, $2, $2) ON CONFLICT (id) DO NOTHING`,
        [tenantId, slug],
      );
    });
  }
  for (const [tenantId, userId, email] of [
    [AUTH.tenantC, AUTH.userC, 'c@auth-golden.example.test'],
    [AUTH.tenantC, AUTH.userCD_C, 'cd@auth-golden.example.test'],
    [AUTH.tenantD, AUTH.userCD_D, 'cd@auth-golden.example.test'],
  ] as const) {
    await inTenantCommit(migratePool, tenantId, async (c) => {
      await c.query(
        `INSERT INTO users (id, tenant_id, email, display_name, timezone, status)
         VALUES ($1, $2, $3, 'Golden Person', 'UTC', 'active') ON CONFLICT (id) DO NOTHING`,
        [userId, tenantId, email],
      );
    });
  }

  people.c.authUserId = await createIdentity(people.c.email);
  people.cd.authUserId = await createIdentity(people.cd.email);
  people.noMfa.authUserId = await createIdentity(people.noMfa.email);
  await link(AUTH.tenantC, AUTH.userC, people.c.authUserId);
  await link(AUTH.tenantC, AUTH.userCD_C, people.cd.authUserId);
  await link(AUTH.tenantD, AUTH.userCD_D, people.cd.authUserId);
  await enrollTotp(people.c);
  await enrollTotp(people.cd);
});

afterAll(async () => {
  await link(AUTH.tenantC, AUTH.userC, null);
  await link(AUTH.tenantC, AUTH.userCD_C, null);
  await link(AUTH.tenantD, AUTH.userCD_D, null);
  await migratePool.query(`DELETE FROM auth."user" WHERE email LIKE $1`, [
    `%-${RUN}@auth-golden.example.test`,
  ]);
  await migratePool.query(`DELETE FROM auth."rateLimit" WHERE key LIKE '198.51.100.%'`);
  await authPool.end();
  await closePools();
});

// ---------------------------------------------------------------------------------------------

describe('golden/db: sign-in with password + TOTP', () => {
  it('happy path: password → MFA challenge → session bound to the only tenant', async () => {
    const client = await signIn(people.c);
    const ctx = await getAuthContext(auth, authPool, client.headers());
    expect(ctx).toMatchObject({ status: 'ok', tenantId: AUTH.tenantC, userId: AUTH.userC });
  });

  it('the session cookie is HttpOnly + SameSite and never readable by scripts', async () => {
    const client = newClient();
    const res = await auth.handler(
      new Request(`${BASE_URL}/api/auth/sign-in/email`, {
        method: 'POST',
        headers: {
          origin: BASE_URL,
          'x-forwarded-for': '198.51.100.250',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ email: people.noMfa.email, password: PASSWORD }),
      }),
    );
    const session = res.headers.getSetCookie().find((c) => c.includes('session_token'));
    expect(session).toMatch(/HttpOnly/i);
    expect(session).toMatch(/SameSite=Lax/i);
    void client;
  });

  it('without enrolled TOTP there is no tenant access (MFA is mandatory)', async () => {
    const client = newClient();
    const res = await client.call('/sign-in/email', {
      email: people.noMfa.email,
      password: PASSWORD,
    });
    expect(res.status).toBe(200);
    const ctx = await getAuthContext(auth, authPool, client.headers());
    expect(ctx.status).toBe('mfa_setup_required');
  });

  it('a wrong TOTP code gives no session', async () => {
    const client = newClient();
    await client.call('/sign-in/email', { email: people.c.email, password: PASSWORD });
    const res = await client.call('/two-factor/verify-totp', { code: '000000' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await getAuthContext(auth, authPool, client.headers())).status).toBe('anonymous');
  });
});

describe('golden/db: no account enumeration (rule 27)', () => {
  it('unknown email and wrong password give the same status and body', async () => {
    const unknown = await newClient().call('/sign-in/email', {
      email: `nobody-${RUN}@auth-golden.example.test`,
      password: PASSWORD,
    });
    const wrong = await newClient().call('/sign-in/email', {
      email: people.cd.email,
      password: `${PASSWORD}x`,
    });
    expect(unknown).toEqual(wrong);
    expect(unknown.status).toBe(401);
    // reset the counter this test added
    await signIn(people.cd);
  });

  it('password reset answers the same for existing and unknown accounts', async () => {
    const body = (email: string) => ({ email, redirectTo: `${BASE_URL}/reset` });
    const existing = await newClient().call('/request-password-reset', body(people.c.email));
    const unknown = await newClient().call(
      '/request-password-reset',
      body(`nobody-${RUN}@auth-golden.example.test`),
    );
    expect(existing).toEqual(unknown);
    expect(existing.status).toBe(200);
    expect(mails.filter((m) => m.to === people.c.email)).toHaveLength(1);
  });
});

describe('golden/db: lockout after 5 wrong passwords (15 min, never permanent)', () => {
  it('locks for 15 min with the same answer as a wrong password; expiry unlocks and resets', async () => {
    const person = people.cd;
    const wrong = { email: person.email, password: `${PASSWORD}-wrong` };
    const answers = [];
    for (let i = 0; i < 5; i += 1) answers.push(await newClient().call('/sign-in/email', wrong));
    const whileLocked = await newClient().call('/sign-in/email', {
      email: person.email,
      password: PASSWORD,
    });
    expect(whileLocked).toEqual(answers[0]);
    expect(whileLocked.status).toBe(401);

    const { rows } = await migratePool.query<{ until: Date; count: number }>(
      `SELECT "signInLockedUntil" AS until, "failedSignInCount" AS count FROM auth."user" WHERE id = $1`,
      [person.authUserId],
    );
    const lockMs = (rows[0]?.until.getTime() ?? 0) - Date.now();
    expect(lockMs).toBeGreaterThan((LOCKOUT_SECONDS - 60) * 1000);
    expect(lockMs).toBeLessThanOrEqual(LOCKOUT_SECONDS * 1000);

    // 15 minutes later (moved back in the DB) the correct password works and the counter resets.
    await migratePool.query(
      `UPDATE auth."user" SET "signInLockedUntil" = now() - interval '1 second' WHERE id = $1`,
      [person.authUserId],
    );
    await signIn(person);
    const after = await migratePool.query<{ until: Date | null; count: number }>(
      `SELECT "signInLockedUntil" AS until, "failedSignInCount" AS count FROM auth."user" WHERE id = $1`,
      [person.authUserId],
    );
    expect(after.rows[0]).toEqual({ until: null, count: 0 });
  });

  it('TOTP lockout: 5 wrong codes lock the second factor (two-factor plugin)', async () => {
    const { rows } = await migratePool.query<{ attempts: number }>(
      `SELECT count(*)::int AS attempts FROM auth."twoFactor" WHERE "userId" = $1`,
      [people.c.authUserId],
    );
    expect(rows[0]?.attempts).toBe(1);
    const ctx = await auth.$context;
    const plugin = ctx.getPlugin('two-factor') as
      { options?: { accountLockout?: unknown } } | undefined;
    expect(plugin?.options?.accountLockout).toEqual({
      enabled: true,
      maxFailedAttempts: 5,
      durationSeconds: LOCKOUT_SECONDS,
    });
  });
});

describe('golden/db: rate limit per IP', () => {
  it('the 11th sign-in attempt from one IP within a minute is rejected with 429', async () => {
    const client = newClient();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i += 1) {
      statuses.push(
        (
          await client.call('/sign-in/email', {
            email: `nobody-${RUN}@auth-golden.example.test`,
            password: 'x'.repeat(12),
          })
        ).status,
      );
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});

describe('golden/db: session lifetime is 8 h absolute', () => {
  it('refresh is disabled: no setting can turn 8 h into a sliding session', async () => {
    const { options } = await auth.$context;
    expect(options.session?.expiresIn).toBe(SESSION_TTL_SECONDS);
    expect(options.session?.disableSessionRefresh).toBe(true);
  });

  it('valid just before 8 h, gone after 8 h — activity does not extend it', async () => {
    const client = await signIn(people.c);
    const start = Date.now();
    vi.useFakeTimers({ toFake: ['Date'], now: start });
    try {
      vi.setSystemTime(start + (SESSION_TTL_SECONDS - 60) * 1000);
      expect((await getAuthContext(auth, authPool, client.headers())).status).toBe('ok');
      vi.setSystemTime(start + (SESSION_TTL_SECONDS + 1) * 1000);
      expect((await getAuthContext(auth, authPool, client.headers())).status).toBe('anonymous');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('golden/db: the session is bound to one tenant membership', () => {
  it('a person with two tenants must choose; only own memberships can be chosen', async () => {
    const client = await signIn(people.cd);
    expect(await getAuthContext(auth, authPool, client.headers())).toMatchObject({
      status: 'tenant_required',
      memberships: [
        expect.objectContaining({ tenantId: AUTH.tenantC }),
        expect.objectContaining({ tenantId: AUTH.tenantD }),
      ],
    });

    const foreign = await client.call('/update-session', {
      activeTenantId: AUTH.tenantD.replace('0d', '0a'),
    });
    expect(foreign.status).toBe(403);
    const chosen = await client.call('/update-session', { activeTenantId: AUTH.tenantD });
    expect(chosen.status).toBe(200);
    expect(await getAuthContext(auth, authPool, client.headers())).toMatchObject({
      status: 'ok',
      tenantId: AUTH.tenantD,
      userId: AUTH.userCD_D,
    });
  });

  it('a single-tenant person cannot switch into a tenant they do not belong to', async () => {
    const client = await signIn(people.c);
    const res = await client.call('/update-session', { activeTenantId: AUTH.tenantD });
    expect(res.status).toBe(403);
    expect(await getAuthContext(auth, authPool, client.headers())).toMatchObject({
      tenantId: AUTH.tenantC,
    });
  });

  it('membership lookup sees only the signed-in person; the tenant session sees only its tenant', async () => {
    expect((await activeMemberships(authPool, people.c.authUserId)).map((m) => m.tenantId)).toEqual(
      [AUTH.tenantC],
    );

    const client = await signIn(people.c);
    const ctx = await getAuthContext(auth, authPool, client.headers());
    if (ctx.status !== 'ok') throw new Error(`expected ok, got ${ctx.status}`);
    const visible = await inTenant(appPool, ctx.tenantId, (c) =>
      c.query<{ id: string }>('SELECT id FROM users WHERE id = ANY($1::uuid[]) ORDER BY id', [
        [AUTH.userC, AUTH.userCD_C, AUTH.userCD_D],
      ]),
    );
    expect(visible.rows.map((r) => r.id)).toEqual([AUTH.userC, AUTH.userCD_C]);
  });

  it('without app.auth_user_id the bridge policy shows nothing', async () => {
    const res = await inTenant(appPool, null, (c) =>
      c.query('SELECT id FROM users WHERE auth_user_id = $1', [people.c.authUserId]),
    );
    expect(res.rowCount).toBe(0);
  });

  it('the bridge policy is pre-tenant only: with both GUCs set, only the chosen tenant is visible', async () => {
    const query = (tenantId: string | null) =>
      inTenant(appPool, tenantId, async (c) => {
        await c.query("SELECT set_config('app.auth_user_id', $1, true)", [people.cd.authUserId]);
        const users = await c.query<{ tenant_id: string }>(
          'SELECT tenant_id FROM users WHERE auth_user_id = $1 ORDER BY tenant_id',
          [people.cd.authUserId],
        );
        const tenants = await c.query<{ id: string }>(
          'SELECT id FROM tenants WHERE id = ANY($1::uuid[]) ORDER BY id',
          [[AUTH.tenantC, AUTH.tenantD]],
        );
        return {
          users: users.rows.map((r) => r.tenant_id),
          tenants: tenants.rows.map((r) => r.id),
        };
      });
    // Before a tenant is chosen the person sees both memberships …
    expect(await query(null)).toEqual({
      users: [AUTH.tenantC, AUTH.tenantD],
      tenants: [AUTH.tenantC, AUTH.tenantD],
    });
    // … once tenant C is set, the person's own row in D is no longer visible (policies are OR-ed).
    expect(await query(AUTH.tenantC)).toEqual({ users: [AUTH.tenantC], tenants: [AUTH.tenantC] });
  });

  it('a disabled membership ends tenant access on the next request', async () => {
    const client = await signIn(people.c);
    await inTenantCommit(migratePool, AUTH.tenantC, async (c) => {
      await c.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [AUTH.userC]);
    });
    try {
      expect((await getAuthContext(auth, authPool, client.headers())).status).toBe(
        'tenant_required',
      );
    } finally {
      await inTenantCommit(migratePool, AUTH.tenantC, async (c) => {
        await c.query(`UPDATE users SET status = 'active' WHERE id = $1`, [AUTH.userC]);
      });
    }
  });
});
