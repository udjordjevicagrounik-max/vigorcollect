import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createAuth, createAuthPool } from '../../src/server/auth/better-auth';
import { grantsByRole, parsePermissionMatrix } from '../../src/server/permissions/matrix';
import { e2eDatabaseUrls } from './e2e-env';
import { Client } from 'pg';

// E2E world in collect_test (never the dev database): tenant G with one owner, and a sign-in
// identity created fresh for this run (random password, no TOTP — the flow enrolls it). The
// credentials reach the workers through process.env and are never printed.
export const E2E = {
  tenantId: '0e2e0000-0000-4000-8000-0000000000e2',
  userId: '3e2e0000-0000-4000-8000-0000000000e2',
  // Second person (task 3.3): the checker of maker-checker flows — never the maker.
  checkerId: '3e2e0000-0000-4000-8000-0000000000e3',
  // The invoicing company (task 2.4 flow: import → case → promise → payment).
  legalEntityId: '1e2e0000-0000-4000-8000-0000000000e2',
  companyId: '2e2e0000-0000-4000-8000-0000000000e2',
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
  const checkerEmail = `e2e-checker-${randomUUID().slice(0, 8)}@e2e.example.test`;
  const checkerPassword = `e2e-${randomBytes(18).toString('base64url')}`;

  const client = new Client({ connectionString: migrate });
  await client.connect();
  await inTenant(client, null, async () => {
    await client.query(
      `INSERT INTO jurisdiction_profiles (country_code, default_currency, default_locale, default_timezone)
       VALUES ('XX', 'EUR', 'en', 'UTC') ON CONFLICT (country_code) DO NOTHING`,
    );
    await client.query(
      `INSERT INTO legal_entities (id, country_code, tax_id, legal_name, normalized_name, timezone)
       VALUES ($1, 'XX', 'E2E-COMPANY', 'E2E Company', 'e2e company', 'UTC') ON CONFLICT (id) DO NOTHING`,
      [E2E.legalEntityId],
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
    await client.query('SELECT provision_receivables_defaults()');
    await client.query(
      `INSERT INTO tenant_companies (id, tenant_id, legal_entity_id, display_name, is_default)
       VALUES ($1, $2, $3, 'E2E Company', true) ON CONFLICT (id) DO NOTHING`,
      [E2E.companyId, E2E.tenantId, E2E.legalEntityId],
    );
    await client.query(
      `INSERT INTO users (id, tenant_id, email, display_name, timezone, status)
       VALUES ($1, $2, 'owner@golden-e2e.example.test', 'E2E Owner', 'UTC', 'active')
       ON CONFLICT (id) DO NOTHING`,
      [E2E.userId, E2E.tenantId],
    );
    // All system roles with their grants from docs/permissions.md (navigation follows them).
    const grants = grantsByRole(parsePermissionMatrix(readFileSync('docs/permissions.md', 'utf8')));
    for (const [role, keys] of grants) {
      await client.query(
        `INSERT INTO roles (tenant_id, key, is_system) VALUES ($1, $2, true)
         ON CONFLICT (tenant_id, key) DO NOTHING`,
        [E2E.tenantId, role],
      );
      await client.query(
        `INSERT INTO role_permissions (tenant_id, role_id, permission_id)
         SELECT $1, r.id, p.id FROM roles r JOIN permissions p ON p.key = ANY($3::text[])
         WHERE r.key = $2 ON CONFLICT DO NOTHING`,
        [E2E.tenantId, role, keys],
      );
    }
    await client.query(
      `INSERT INTO users (id, tenant_id, email, display_name, timezone, status)
       VALUES ($1, $2, 'checker@golden-e2e.example.test', 'E2E Checker', 'UTC', 'active')
       ON CONFLICT (id) DO NOTHING`,
      [E2E.checkerId, E2E.tenantId],
    );
    for (const id of [E2E.userId, E2E.checkerId]) {
      await client.query(
        `INSERT INTO user_roles (tenant_id, user_id, role_id, scope)
         SELECT $1, $2, id, 'ORGANIZATION' FROM roles WHERE key = 'owner'
         ON CONFLICT (tenant_id, user_id, role_id) DO NOTHING`,
        [E2E.tenantId, id],
      );
    }
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
  const checker = await ctx.internalAdapter.createUser(
    { email: checkerEmail, name: 'E2E Checker', emailVerified: true },
    { method: 'admin' },
  );
  await ctx.internalAdapter.linkAccount({
    userId: checker.id,
    providerId: 'credential',
    accountId: checker.id,
    password: await ctx.password.hash(checkerPassword),
  });
  await inTenant(client, E2E.tenantId, async () => {
    await client.query('UPDATE users SET auth_user_id = $1 WHERE id = $2', [user.id, E2E.userId]);
    await client.query('UPDATE users SET auth_user_id = $1 WHERE id = $2', [
      checker.id,
      E2E.checkerId,
    ]);
  });

  process.env.E2E_EMAIL = email;
  process.env.E2E_PASSWORD = password;
  process.env.E2E_CHECKER_EMAIL = checkerEmail;
  process.env.E2E_CHECKER_PASSWORD = checkerPassword;

  return async () => {
    await inTenant(client, E2E.tenantId, async () => {
      await client.query('UPDATE users SET auth_user_id = NULL WHERE id = ANY($1::uuid[])', [
        [E2E.userId, E2E.checkerId],
      ]);
    });
    await inTenant(client, E2E.tenantId, async () => {
      // People invited during this run (tests/e2e/admin-users.spec.ts).
      const invited = `SELECT id FROM users WHERE email::text LIKE 'e2e-invite-%'`;
      await client.query(`DELETE FROM user_invitations WHERE user_id IN (${invited})`);
      await client.query(`DELETE FROM approval_requests WHERE entity_id IN (${invited})`);
      await client.query(`DELETE FROM user_roles WHERE user_id IN (${invited})`);
      await client.query(`DELETE FROM users WHERE id IN (${invited})`);
      await client.query('DELETE FROM mail_outbox');
      // e2e starts no renderer service: render jobs of this run never finish — remove them, or
      // tests/golden/db/renderer.test.ts would pick them up from the shared test database.
      await client.query('DELETE FROM render_jobs');
    });
    await client.query(`DELETE FROM auth."user" WHERE email LIKE 'e2e-invite-%'`);
    await client.query(`DELETE FROM auth."user" WHERE id = ANY($1::uuid[])`, [
      [user.id, checker.id],
    ]);
    await client.query(
      `DELETE FROM auth."rateLimit" WHERE key LIKE '127.0.0.1%' OR key LIKE '::%'`,
    );
    await client.end();
    await pool.end();
  };
}
