import { randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAuth, createAuthPool } from '@/server/auth/better-auth';
import {
  acceptInvitation,
  createInvitation,
  hashInviteToken,
  InvitationError,
  previewInvitation,
} from '@/server/auth/invitations';
import { getAuthContext } from '@/server/auth/session';
import { createTenantContext } from '@/server/auth/with-tenant';
import { parseMasterKeyring } from '@/server/crypto/keyring';
import { readOutbox, sendMail } from '@/server/mail/adapter';
import { createAuthMailer } from '@/server/mail/auth-mailer';
import { AuthClient } from './auth-client';
import {
  appPool,
  closePools,
  inTenant,
  inTenantCommit,
  migratePool,
  savepointState,
} from './helpers';

// Golden (never delete or skip): one-time invitations (hash only, 72 h, single use, exact users
// row, role rules), the mail sink (encrypted, no PII in the log, demo tenant never SMTP — rule 24),
// hashed reset tokens and "a password change ends the other sessions" (ADR 0004, task 1.1b).
//
// Own tenants E (regular) and F (demo). Tokens and passwords are random per run, never printed.

const BASE_URL = 'http://localhost:3000';
const T = {
  tenantE: '0e000000-0000-4000-8000-00000000000e',
  tenantF: '0f000000-0000-4000-8000-00000000000f',
  ownerE: '3e000000-0000-4000-8000-0000000000e1',
  adminE: '3e000000-0000-4000-8000-0000000000e2',
  collectorE: '3e000000-0000-4000-8000-0000000000e3',
  ownerF: '3f000000-0000-4000-8000-0000000000f1',
} as const;

const RUN = randomUUID().slice(0, 8);
const PASSWORD = `pw-${randomBytes(18).toString('base64url')}`;
const keyring = parseMasterKeyring(`1:${randomBytes(32).toString('base64')}`);
const email = (name: string) => `${name}-${RUN}@invite-golden.example.test`;

const authPool = createAuthPool(process.env.TEST_DATABASE_URL ?? '');
const auth = createAuth(
  {
    connectionString: '',
    secret: randomBytes(32).toString('base64'),
    baseURL: BASE_URL,
    issuer: 'Golden',
    mailer: createAuthMailer({ pool: appPool, keyring: () => keyring }),
  },
  authPool,
);

let ip = 0;
const client = () => new AuthClient(auth, BASE_URL, `203.0.113.${(ip += 1)}`);

/** withTenant()'s context for a member, on a client already inside the tenant transaction. */
const memberContext = (c: PoolClient, tenantId: string, userId: string) =>
  createTenantContext(c, { tenantId, userId, authUserId: randomUUID(), requestId: randomUUID() });

/** Invites as `actor` in `tenantId`; returns the plaintext token read back from the sink. */
async function invite(
  tenantId: string,
  actor: string,
  to: string,
  roleKey = 'collector',
): Promise<{ invitationId: string; userId: string; token: string }> {
  let created: { invitationId: string; userId: string } | undefined;
  let token = '';
  await inTenantCommit(appPool, tenantId, async (c) => {
    created = await createInvitation(
      memberContext(c, tenantId, actor),
      { keyring, baseURL: BASE_URL },
      { email: to, displayName: 'Golden Invitee', roleKey },
    );
    const [mail] = await readOutbox(c, keyring, { kind: 'invitation', limit: 1 });
    token = /\/invite\/([A-Za-z0-9_-]{43})/.exec(mail?.text ?? '')?.[1] ?? '';
  });
  if (!created || !token) throw new Error('invitation not created');
  return { ...created, token };
}

async function inviteError(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'OK';
  } catch (error) {
    if (error instanceof InvitationError) return error.code;
    throw error;
  }
}

beforeAll(async () => {
  await inTenantCommit(migratePool, null, async (c) => {
    await c.query(
      `INSERT INTO jurisdiction_profiles (country_code, default_currency, default_locale, default_timezone)
       VALUES ('XX', 'EUR', 'en', 'UTC') ON CONFLICT (country_code) DO NOTHING`,
    );
  });
  for (const [tenantId, slug, isDemo, users] of [
    [
      T.tenantE,
      'golden-invite-e',
      false,
      [
        [T.ownerE, 'owner'],
        [T.adminE, 'admin'],
        [T.collectorE, 'collector'],
      ],
    ],
    [T.tenantF, 'golden-invite-f', true, [[T.ownerF, 'owner']]],
  ] as const) {
    await inTenantCommit(migratePool, tenantId, async (c) => {
      await c.query(
        `INSERT INTO tenants (id, slug, display_name, is_demo) VALUES ($1, $2, $2, $3)
         ON CONFLICT (id) DO UPDATE SET is_demo = EXCLUDED.is_demo`,
        [tenantId, slug, isDemo],
      );
      await c.query(
        `INSERT INTO tenant_settings (tenant_id, timezone, default_currency, country_code)
         VALUES ($1, 'UTC', 'EUR', 'XX') ON CONFLICT (tenant_id) DO NOTHING`,
        [tenantId],
      );
      for (const role of ['owner', 'admin', 'collector']) {
        await c.query(
          `INSERT INTO roles (tenant_id, key, is_system) VALUES ($1, $2, true)
           ON CONFLICT (tenant_id, key) DO NOTHING`,
          [tenantId, role],
        );
      }
      for (const [userId, role] of users) {
        await c.query(
          `INSERT INTO users (id, tenant_id, email, display_name, timezone, status)
           VALUES ($1, $2, $3, 'Golden Member', 'UTC', 'active') ON CONFLICT (id) DO NOTHING`,
          [userId, tenantId, `${role}@${slug}.example.test`],
        );
        await c.query(
          `INSERT INTO user_roles (tenant_id, user_id, role_id, scope)
           SELECT $1, $2, id, 'ORGANIZATION' FROM roles WHERE key = $3
           ON CONFLICT (tenant_id, user_id, role_id) DO NOTHING`,
          [tenantId, userId, role],
        );
      }
    });
  }
});

afterAll(async () => {
  // Per-run rows only (random e-mails); fixtures above stay.
  for (const tenantId of [T.tenantE, T.tenantF]) {
    await inTenantCommit(migratePool, tenantId, async (c) => {
      const runUsers = `SELECT id FROM users WHERE email::text LIKE '%-${RUN}@invite-golden.example.test'`;
      await c.query(`DELETE FROM user_invitations WHERE user_id IN (${runUsers})`);
      await c.query(`DELETE FROM user_roles WHERE user_id IN (${runUsers})`);
      await c.query(`DELETE FROM users WHERE id IN (${runUsers})`);
      await c.query('DELETE FROM mail_outbox');
    });
  }
  await migratePool.query(`DELETE FROM auth."user" WHERE email LIKE $1`, [
    `%-${RUN}@invite-golden.example.test`,
  ]);
  await migratePool.query(`DELETE FROM auth."rateLimit" WHERE key LIKE '203.0.113.%'`);
  await authPool.end();
  await closePools();
});

// ---------------------------------------------------------------------------------------------

describe('golden/db: invitation token is stored only as a hash', () => {
  it('the table keeps sha256(token); the token appears in no column, audit row or log', async () => {
    const write = vi.spyOn(process.stdout, 'write');
    const inv = await invite(T.tenantE, T.ownerE, email('hash'));
    const logged = write.mock.calls.map((call) => String(call[0])).join('');
    write.mockRestore();

    const row = await inTenant(appPool, T.tenantE, async (c) => {
      const invitation = await c.query<{ token_hash: Buffer; expires_in_h: number }>(
        `SELECT token_hash, extract(epoch FROM expires_at - created_at) / 3600 AS expires_in_h
         FROM user_invitations WHERE id = $1`,
        [inv.invitationId],
      );
      const dump = await c.query<{ dump: string }>(
        `SELECT (SELECT string_agg(i::text, '|') FROM user_invitations i) ||
                (SELECT string_agg(a::text, '|') FROM audit_log a) ||
                (SELECT string_agg(m::text, '|') FROM mail_outbox m) AS dump`,
      );
      return { ...invitation.rows[0], dump: dump.rows[0]?.dump ?? '' };
    });
    expect(row.token_hash?.equals(hashInviteToken(inv.token))).toBe(true);
    expect(Number(row.expires_in_h)).toBe(72);
    expect(row.dump).not.toContain(inv.token);
    expect(row.dump).not.toContain(email('hash'));
    expect(logged).toContain('mail.captured');
    expect(logged).not.toContain(inv.token);
    expect(logged).not.toContain(email('hash'));
  });
});

describe('golden/db: accepting binds exactly the invited users row', () => {
  it('new person: identity + link + role (scope OWN) + audit; the other invitee stays untouched', async () => {
    const mine = await invite(T.tenantE, T.ownerE, email('mine'));
    const other = await invite(T.tenantE, T.ownerE, email('other'));

    expect(await previewInvitation(appPool, auth, mine.token)).toMatchObject({
      status: 'valid',
      email: email('mine'),
      roleKey: 'collector',
      identityExists: false,
    });
    const accepted = await acceptInvitation(appPool, auth, mine.token, {
      mode: 'new',
      password: PASSWORD,
    });
    expect(accepted).toMatchObject({ tenantId: T.tenantE, userId: mine.userId });

    const state = await inTenant(appPool, T.tenantE, async (c) => {
      const users = await c.query<{ id: string; status: string; linked: boolean }>(
        `SELECT id, status, auth_user_id IS NOT NULL AS linked FROM users
         WHERE id = ANY($1::uuid[]) ORDER BY email`,
        [[mine.userId, other.userId]],
      );
      const roles = await c.query<{ key: string; scope: string }>(
        `SELECT r.key, ur.scope FROM user_roles ur JOIN roles r ON r.id = ur.role_id
         WHERE ur.user_id = $1`,
        [mine.userId],
      );
      const audit = await c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM audit_log
         WHERE action = 'user_invitation.accepted' AND entity_id = $1`,
        [mine.invitationId],
      );
      return { users: users.rows, roles: roles.rows, audit: audit.rows[0]?.n };
    });
    expect(state.users).toEqual([
      { id: mine.userId, status: 'active', linked: true },
      { id: other.userId, status: 'invited', linked: false },
    ]);
    expect(state.roles).toEqual([{ key: 'collector', scope: 'OWN' }]);
    expect(state.audit).toBe(1);

    // The new person can sign in; MFA setup is the next step (MFA is mandatory).
    const c = client();
    expect(
      (await c.call('/sign-in/email', { email: email('mine'), password: PASSWORD })).status,
    ).toBe(200);
    expect(await getAuthContext(auth, authPool, c.headers())).toMatchObject({
      status: 'mfa_setup_required',
    });
  });

  it('a person who already has an identity must accept while signed in as that person', async () => {
    const first = await invite(T.tenantE, T.ownerE, email('twice'));
    await acceptInvitation(appPool, auth, first.token, { mode: 'new', password: PASSWORD });
    const second = await invite(T.tenantF, T.ownerF, email('twice'));

    expect(
      await inviteError(
        acceptInvitation(appPool, auth, second.token, { mode: 'new', password: PASSWORD }),
      ),
    ).toBe('sign_in_required');
    expect(
      await inviteError(
        acceptInvitation(appPool, auth, second.token, {
          mode: 'existing',
          authUserId: randomUUID(),
        }),
      ),
    ).toBe('wrong_account');
    const ctx = await auth.$context;
    const identity = await ctx.internalAdapter.findUserByEmail(email('twice'));
    expect(
      await acceptInvitation(appPool, auth, second.token, {
        mode: 'existing',
        authUserId: identity?.user.id ?? '',
      }),
    ).toMatchObject({ tenantId: T.tenantF, userId: second.userId });
  });

  it('a too-short password creates nothing; the invitation stays usable', async () => {
    const inv = await invite(T.tenantE, T.ownerE, email('short'));
    expect(
      await inviteError(acceptInvitation(appPool, auth, inv.token, { mode: 'new', password: 'x' })),
    ).toBe('weak_password');
    const ctx = await auth.$context;
    expect(await ctx.internalAdapter.findUserByEmail(email('short'))).toBeNull();
    expect((await previewInvitation(appPool, auth, inv.token)).status).toBe('valid');
  });
});

describe('golden/db: the token is single-use and expires', () => {
  it('second use is rejected — by the service and by the database trigger', async () => {
    const inv = await invite(T.tenantE, T.ownerE, email('once'));
    await acceptInvitation(appPool, auth, inv.token, { mode: 'new', password: PASSWORD });
    expect(
      await inviteError(
        acceptInvitation(appPool, auth, inv.token, { mode: 'new', password: PASSWORD }),
      ),
    ).toBe('invalid');
    expect((await previewInvitation(appPool, auth, inv.token)).status).toBe('invalid');
    const reopen = await inTenant(appPool, T.tenantE, (c) =>
      savepointState(
        c,
        `UPDATE user_invitations SET status = 'pending', used_at = NULL WHERE id = $1`,
        [inv.invitationId],
      ),
    );
    expect(reopen).toBe('23514');
  });

  it('after 72 h the invitation is expired — service and trigger refuse it', async () => {
    const token = randomBytes(32).toString('base64url');
    const userId = randomUUID();
    let invitationId = '';
    await inTenantCommit(migratePool, T.tenantE, async (c) => {
      await c.query(
        `INSERT INTO users (id, tenant_id, email, display_name, timezone, status)
         VALUES ($1, $2, $3, 'Golden Late', 'UTC', 'invited')`,
        [userId, T.tenantE, email('late')],
      );
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO user_invitations (tenant_id, user_id, role_key, token_hash, invited_by,
                                       created_at, expires_at)
         VALUES ($1, $2, 'collector', $3, $4, now() - interval '73 hours', now() - interval '1 hour')
         RETURNING id`,
        [T.tenantE, userId, hashInviteToken(token), T.ownerE],
      );
      invitationId = rows[0]?.id ?? '';
    });
    expect(await previewInvitation(appPool, auth, token)).toMatchObject({ status: 'expired' });
    expect(
      await inviteError(
        acceptInvitation(appPool, auth, token, { mode: 'new', password: PASSWORD }),
      ),
    ).toBe('expired');
    const direct = await inTenant(appPool, T.tenantE, (c) =>
      savepointState(
        c,
        `UPDATE user_invitations SET status = 'accepted', used_at = now() WHERE id = $1`,
        [invitationId],
      ),
    );
    expect(direct).toBe('23514');
  });

  it('re-sending issues a new token and revokes the old one', async () => {
    const old = await invite(T.tenantE, T.ownerE, email('resend'));
    const fresh = await invite(T.tenantE, T.ownerE, email('resend'));
    expect(fresh.userId).toBe(old.userId);
    expect((await previewInvitation(appPool, auth, old.token)).status).toBe('invalid');
    expect((await previewInvitation(appPool, auth, fresh.token)).status).toBe('valid');
  });

  it('the app can never delete an invitation', async () => {
    const state = await inTenant(appPool, T.tenantE, (c) =>
      savepointState(c, 'DELETE FROM user_invitations'),
    );
    expect(state).toBe('42501');
  });
});

describe('golden/db: invitations are tenant-isolated', () => {
  it('tenant E sees none of F’s invitations; the token lookup works only without a tenant', async () => {
    const inF = await invite(T.tenantF, T.ownerF, email('isolated'));
    const seen = await inTenant(appPool, T.tenantE, async (c) => {
      const all = await c.query('SELECT 1 FROM user_invitations WHERE id = $1', [inF.invitationId]);
      await c.query("SELECT set_config('app.invite_token_hash', $1, true)", [
        hashInviteToken(inF.token).toString('hex'),
      ]);
      const byToken = await c.query('SELECT 1 FROM user_invitations WHERE id = $1', [
        inF.invitationId,
      ]);
      return { all: all.rowCount, byToken: byToken.rowCount };
    });
    expect(seen).toEqual({ all: 0, byToken: 0 });

    const anonymous = await inTenant(appPool, null, (c) =>
      c.query<{ n: number }>('SELECT count(*)::int AS n FROM user_invitations'),
    );
    expect(anonymous.rows[0]?.n).toBe(0);
  });
});

describe('golden/db: who may invite whom', () => {
  it('owner → any role; admin → not owner; collector → nobody', async () => {
    const attempt = (actor: string, roleKey: string, name: string) =>
      inTenant(appPool, T.tenantE, (c) =>
        inviteError(
          createInvitation(
            memberContext(c, T.tenantE, actor),
            { keyring, baseURL: BASE_URL },
            { email: email(name), displayName: 'Golden', roleKey },
          ),
        ),
      );
    expect(await attempt(T.ownerE, 'owner', 'o-o')).toBe('OK');
    expect(await attempt(T.adminE, 'admin', 'a-a')).toBe('OK');
    expect(await attempt(T.adminE, 'owner', 'a-o')).toBe('forbidden_role');
    expect(await attempt(T.collectorE, 'collector', 'c-c')).toBe('forbidden_role');
    expect(await attempt(T.ownerE, 'no_such_role', 'o-x')).toBe('unknown_role');
  });
});

describe('golden/db: mail sink (rule 24)', () => {
  const mail = (to: string) =>
    ({ kind: 'password_reset', to, locale: 'en', url: `${BASE_URL}/reset/x` }) as const;

  it('a demo tenant always uses the sink, even with SMTP enabled; a regular tenant would queue', async () => {
    const demo = await inTenant(appPool, T.tenantF, (c) =>
      sendMail(c, keyring, mail(email('demo')), { smtpEnabled: true }),
    );
    const regular = await inTenant(appPool, T.tenantE, (c) =>
      sendMail(c, keyring, mail(email('regular')), { smtpEnabled: true }),
    );
    expect([demo.transport, regular.transport]).toEqual(['sink', 'smtp']);
  });

  it('the database refuses a non-sink row for a demo tenant', async () => {
    const state = await inTenant(appPool, T.tenantF, (c) =>
      savepointState(
        c,
        `INSERT INTO mail_outbox (tenant_id, kind, transport, status, recipient_enc,
                                  recipient_key_version, body_enc, body_key_version)
         VALUES ($1, 'invitation', 'smtp', 'pending', '\\x00', 1, '\\x00', 1)`,
        [T.tenantF],
      ),
    );
    expect(state).toBe('23514');
  });

  it('recipient and body are encrypted and readable only with the keyring of the tenant', async () => {
    const stored = await inTenant(appPool, T.tenantE, async (c) => {
      await sendMail(c, keyring, mail(email('enc')));
      const raw = await c.query<{ r: Buffer; b: Buffer }>(
        `SELECT recipient_enc AS r, body_enc AS b FROM mail_outbox ORDER BY created_at DESC LIMIT 1`,
      );
      const [read] = await readOutbox(c, keyring, { limit: 1 });
      return { raw: raw.rows[0], read };
    });
    expect(stored.raw?.r.toString('utf8')).not.toContain(email('enc'));
    expect(stored.raw?.b.toString('utf8')).not.toContain('/reset/');
    expect(stored.read).toMatchObject({ to: email('enc'), kind: 'password_reset' });
    expect(stored.read?.text).toContain(`${BASE_URL}/reset/x`);
  });

  it('the app cannot change or delete captured mail', async () => {
    const states = await inTenant(appPool, T.tenantE, async (c) => ({
      update: await savepointState(c, `UPDATE mail_outbox SET status = 'sent', sent_at = now()`),
      del: await savepointState(c, 'DELETE FROM mail_outbox'),
    }));
    expect(states).toEqual({ update: '42501', del: '42501' });
  });
});

describe('golden/db: password reset and change (Better Auth)', () => {
  it('reset mail goes through the sink of the member’s tenant; the token is stored hashed', async () => {
    const inv = await invite(T.tenantE, T.ownerE, email('reset'));
    await acceptInvitation(appPool, auth, inv.token, { mode: 'new', password: PASSWORD });

    const res = await client().call('/request-password-reset', {
      email: email('reset'),
      redirectTo: `${BASE_URL}/reset`,
    });
    expect(res.status).toBe(200);
    const [captured] = await inTenant(appPool, T.tenantE, (c) =>
      readOutbox(c, keyring, { kind: 'password_reset', limit: 1 }),
    );
    expect(captured?.to).toBe(email('reset'));
    const resetToken = /reset-password\/([^?\s]+)/.exec(captured?.text ?? '')?.[1] ?? '';
    expect(resetToken.length).toBeGreaterThan(10);

    const { rows } = await migratePool.query<{ identifier: string }>(
      `SELECT identifier FROM auth.verification`,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.identifier.includes(resetToken))).toBe(false);
  });

  it('changing the password ends every other session, even if the client asks to keep them', async () => {
    const inv = await invite(T.tenantE, T.ownerE, email('change'));
    await acceptInvitation(appPool, auth, inv.token, { mode: 'new', password: PASSWORD });
    const here = client();
    const elsewhere = client();
    for (const c of [here, elsewhere]) {
      expect(
        (await c.call('/sign-in/email', { email: email('change'), password: PASSWORD })).status,
      ).toBe(200);
    }
    const changed = await here.call('/change-password', {
      currentPassword: PASSWORD,
      newPassword: `${PASSWORD}-new`,
      revokeOtherSessions: false,
    });
    expect(changed.status).toBe(200);
    expect(await auth.api.getSession({ headers: elsewhere.headers() })).toBeNull();
    expect(await auth.api.getSession({ headers: here.headers() })).not.toBeNull();
  });
});
