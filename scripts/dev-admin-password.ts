/**
 * Dev only: sets a new random password for the demo tenant's admin and prints it ONCE.
 * Refuses unless NODE_ENV !== production, the database is `collect` (not *_test, not prod),
 * BETTER_AUTH_URL is http://localhost / http://127.0.0.1 and stdout is a real terminal
 * (scripts/lib/dev-guard.ts). Run it in your own SSH terminal — never through Claude (`!`):
 * the password must not end up in a chat or a log. Change it right away at /settings/password.
 *
 * All sessions of the admin are revoked and the lockout counter is reset. TOTP stays as is.
 */
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { createAuth, createAuthPool } from '../src/server/auth/better-auth';
import { devGuardViolations } from './lib/dev-guard';

// scripts/seed-demo.ts — DEMO_TENANT and its admin user.
const DEMO_TENANT_ID = 'd0000000-0000-4000-8000-000000000001';
const DEMO_ADMIN_USER_ID = 'd0000000-0000-4000-8000-000000000a01';

async function main(): Promise<void> {
  if (!process.env.MIGRATE_DATABASE_URL && existsSync('.env')) process.loadEnvFile('.env');
  const url = process.env.MIGRATE_DATABASE_URL;
  const violations = devGuardViolations({
    nodeEnv: process.env.NODE_ENV,
    databaseUrl: url,
    appUrl: process.env.BETTER_AUTH_URL,
    stdoutIsTTY: Boolean(process.stdout.isTTY),
  });
  if (violations.length || !url) {
    console.error(`dev-admin-password: refused — ${violations.join('; ')}.`);
    process.exit(2);
  }
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error('BETTER_AUTH_SECRET is not set (docs/runbook.md "Auth").');

  const client = new Client({ connectionString: url });
  await client.connect();
  let authUserId: string | undefined;
  let email: string | undefined;
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [DEMO_TENANT_ID]);
    const { rows } = await client.query<{
      auth_user_id: string | null;
      email: string;
      is_demo: boolean;
    }>(
      `SELECT u.auth_user_id, u.email, t.is_demo
       FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.id = $1`,
      [DEMO_ADMIN_USER_ID],
    );
    await client.query('COMMIT');
    const row = rows[0];
    if (!row?.is_demo)
      throw new Error('demo tenant not found or not marked is_demo — run the seed.');
    if (!row.auth_user_id) throw new Error('demo admin has no sign-in identity — run the seed.');
    authUserId = row.auth_user_id;
    email = row.email;
  } finally {
    await client.end();
  }

  const pool = createAuthPool(url);
  try {
    const auth = createAuth(
      { connectionString: url, secret, baseURL: process.env.BETTER_AUTH_URL ?? '', issuer: 'dev' },
      pool,
    );
    const ctx = await auth.$context;
    const password = randomBytes(18).toString('base64url');
    await ctx.internalAdapter.updatePassword(authUserId, await ctx.password.hash(password));
    await ctx.internalAdapter.updateUser(authUserId, {
      failedSignInCount: 0,
      signInLockedUntil: null,
    });
    await ctx.internalAdapter.deleteUserSessions(authUserId);
    process.stdout.write(
      `\n  ${email}\n  new password: ${password}\n\n` +
        '  WARNING: shown once. Change it NOW at /settings/password (promeni odmah).\n\n',
    );
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
