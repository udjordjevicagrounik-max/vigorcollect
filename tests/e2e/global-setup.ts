import { randomBytes, randomUUID } from 'node:crypto';
import { createAuth, createAuthPool } from '../../src/server/auth/better-auth';
import { e2eDatabaseUrls } from './e2e-env';
import { Client } from 'pg';

// E2E world in collect_test (never the dev database): tenant G with one owner, and a sign-in
// identity created fresh for this run (random password, no TOTP — the flow enrolls it). The
// credentials reach the workers through process.env and are never printed.
export const E2E = {
  tenantId: '0e2e0000-0000-4000-8000-0000000000e2',
  userId: '3e2e0000-0000-4000-8000-0000000000e2',
} as const;

async function inTenant(client: Client, tenantId: string | null, fn: () => Promise<void>) {
  await client.query('BEGIN');
  try {
    if (tenantId) await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    await fn();
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const { migrate } = e2eDatabaseUrls();
  const email = `e2e-${randomUUID().slice(0, 8)}@e2e.example.test`;
  const password = `e2e-${randomBytes(18).toString('base64url')}`;

  const client = new Client({ connectionString: migrate });
  await client.connect();
  await inTenant(client, null, async () => {
    await client.query(
      `INSERT INTO jurisdiction_profiles (country_code, default_currency, default_locale, default_timezone)
       VALUES ('XX', 'EUR', 'en', 'UTC') ON CONFLICT (country_code) DO NOTHING`,
    );
  });
  await inTenant(client, E2E.tenantId, async () => {
    await client.query(
      `INSERT INTO tenants (id, slug, display_name, is_demo) VALUES ($1, 'golden-e2e', 'E2E Company', true)
       ON CONFLICT (id) DO NOTHING`,
      [E2E.tenantId],
    );
    await client.query(
      `INSERT INTO tenant_settings (tenant_id, timezone, default_currency, country_code)
       VALUES ($1, 'UTC', 'EUR', 'XX') ON CONFLICT (tenant_id) DO NOTHING`,
      [E2E.tenantId],
    );
    await client.query(
      `INSERT INTO users (id, tenant_id, email, display_name, timezone, status)
       VALUES ($1, $2, 'owner@golden-e2e.example.test', 'E2E Owner', 'UTC', 'active')
       ON CONFLICT (id) DO NOTHING`,
      [E2E.userId, E2E.tenantId],
    );
    await client.query(
      `INSERT INTO roles (tenant_id, key, is_system) VALUES ($1, 'owner', true)
       ON CONFLICT (tenant_id, key) DO NOTHING`,
      [E2E.tenantId],
    );
    await client.query(
      `INSERT INTO user_roles (tenant_id, user_id, role_id, scope)
       SELECT $1, $2, id, 'ORGANIZATION' FROM roles WHERE key = 'owner'
       ON CONFLICT (tenant_id, user_id, role_id) DO NOTHING`,
      [E2E.tenantId, E2E.userId],
    );
  });

  const pool = createAuthPool(migrate);
  const auth = createAuth(
    {
      connectionString: migrate,
      secret: randomBytes(32).toString('base64'),
      baseURL: 'http://localhost',
      issuer: 'e2e',
    },
    pool,
  );
  const ctx = await auth.$context;
  const user = await ctx.internalAdapter.createUser(
    { email, name: 'E2E Owner', emailVerified: true },
    { method: 'admin' },
  );
  await ctx.internalAdapter.linkAccount({
    userId: user.id,
    providerId: 'credential',
    accountId: user.id,
    password: await ctx.password.hash(password),
  });
  await inTenant(client, E2E.tenantId, async () => {
    await client.query('UPDATE users SET auth_user_id = $1 WHERE id = $2', [user.id, E2E.userId]);
  });

  process.env.E2E_EMAIL = email;
  process.env.E2E_PASSWORD = password;

  return async () => {
    await inTenant(client, E2E.tenantId, async () => {
      await client.query('UPDATE users SET auth_user_id = NULL WHERE id = $1', [E2E.userId]);
    });
    await client.query(`DELETE FROM auth."user" WHERE id = $1`, [user.id]);
    await client.query(
      `DELETE FROM auth."rateLimit" WHERE key LIKE '127.0.0.1%' OR key LIKE '::%'`,
    );
    await client.end();
    await pool.end();
  };
}
