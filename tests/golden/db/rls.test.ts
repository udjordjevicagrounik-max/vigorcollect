import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureFixtures, FX } from './fixtures';
import { appPool, closePools, inTenant, migratePool, sqlState } from './helpers';

// Golden (never delete or skip): tenant isolation on the live schema (rules 1, 2, 3, 30, 33).

// Static SQL per table — identifiers are never interpolated (rule 5).
const TENANT_TABLE_COUNTS: Record<string, string> = {
  tenants: 'SELECT count(*)::int AS n FROM tenants',
  tenant_settings: 'SELECT count(*)::int AS n FROM tenant_settings',
  tenant_companies: 'SELECT count(*)::int AS n FROM tenant_companies',
  users: 'SELECT count(*)::int AS n FROM users',
  roles: 'SELECT count(*)::int AS n FROM roles',
  role_permissions: 'SELECT count(*)::int AS n FROM role_permissions',
  user_roles: 'SELECT count(*)::int AS n FROM user_roles',
  feature_flags: 'SELECT count(*)::int AS n FROM feature_flags',
  audit_log: 'SELECT count(*)::int AS n FROM audit_log',
  domain_events: 'SELECT count(*)::int AS n FROM domain_events',
  subject_keys: 'SELECT count(*)::int AS n FROM subject_keys',
  customers: 'SELECT count(*)::int AS n FROM customers',
  customer_contacts: 'SELECT count(*)::int AS n FROM customer_contacts',
  code_lists: 'SELECT count(*)::int AS n FROM code_lists',
  translations: 'SELECT count(*)::int AS n FROM translations',
  external_parties: 'SELECT count(*)::int AS n FROM external_parties',
  access_grants: 'SELECT count(*)::int AS n FROM access_grants',
  data_sources: 'SELECT count(*)::int AS n FROM data_sources',
  approval_requests: 'SELECT count(*)::int AS n FROM approval_requests',
  decisions: 'SELECT count(*)::int AS n FROM decisions',
  export_log: 'SELECT count(*)::int AS n FROM export_log',
  user_invitations: 'SELECT count(*)::int AS n FROM user_invitations',
  mail_outbox: 'SELECT count(*)::int AS n FROM mail_outbox',
};

beforeAll(ensureFixtures);
afterAll(closePools);

describe('golden/db: RLS is on, forced and has a policy on every table', () => {
  it('pg_class: relrowsecurity AND relforcerowsecurity AND >= 1 policy (except the 000 ledger)', async () => {
    const { rows } = await migratePool.query<{ table: string; problem: string }>(
      `SELECT c.relname AS table,
              concat_ws(',',
                CASE WHEN NOT c.relrowsecurity THEN 'ENABLE' END,
                CASE WHEN NOT c.relforcerowsecurity THEN 'FORCE' END,
                CASE WHEN NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid) THEN 'POLICY' END
              ) AS problem
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname IN ('public', 'auth') AND c.relkind = 'r' AND c.relname <> 'schema_migrations'
       ORDER BY 1`,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((r) => r.problem !== '')).toEqual([]);
  });

  it('vigor_app is neither SUPERUSER nor BYPASSRLS (rule 3)', async () => {
    const { rows } = await appPool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
    );
    expect(rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });
});

describe('golden/db: no tenant context → no rows', () => {
  for (const [table, sql] of Object.entries(TENANT_TABLE_COUNTS)) {
    it(`${table}: 0 rows for vigor_app and for the owner without SET LOCAL app.tenant_id`, async () => {
      const app = await inTenant(appPool, null, (c) => c.query<{ n: number }>(sql));
      const owner = await inTenant(migratePool, null, (c) => c.query<{ n: number }>(sql));
      expect(app.rows[0]?.n).toBe(0);
      expect(owner.rows[0]?.n).toBe(0);
    });
  }
});

describe('golden/db: tenant A never sees tenant B', () => {
  it('users: A sees only its own users, B’s user id returns nothing', async () => {
    const own = await inTenant(appPool, FX.tenantA, (c) =>
      c.query<{ id: string }>('SELECT id FROM users ORDER BY id'),
    );
    expect(own.rows.map((r) => r.id)).toEqual([FX.userA, FX.userA2]);

    const foreign = await inTenant(appPool, FX.tenantA, (c) =>
      c.query('SELECT id FROM users WHERE id = $1', [FX.userB]),
    );
    expect(foreign.rowCount).toBe(0);
  });

  it('writing a row for tenant B while in tenant A is rejected (WITH CHECK)', async () => {
    const state = await inTenant(appPool, FX.tenantA, (c) =>
      sqlState(
        c.query(
          `INSERT INTO users (tenant_id, email, display_name, timezone)
           VALUES ($1, 'intruder@golden.example.test', 'Intruder', 'UTC')`,
          [FX.tenantB],
        ),
      ),
    );
    expect(state).toBe('42501');
  });

  it('cross-tenant reference is impossible: user of A + role of B fails the composite FK', async () => {
    const state = await inTenant(appPool, FX.tenantA, (c) =>
      sqlState(
        c.query('INSERT INTO user_roles (tenant_id, user_id, role_id) VALUES ($1, $2, $3)', [
          FX.tenantA,
          FX.userA,
          FX.roleB,
        ]),
      ),
    );
    expect(state).toBe('23503');
  });

  it('tenant-scoped insert inside the own tenant works (control)', async () => {
    const state = await inTenant(appPool, FX.tenantA, (c) =>
      sqlState(
        c.query('INSERT INTO user_roles (tenant_id, user_id, role_id) VALUES ($1, $2, $3)', [
          FX.tenantA,
          FX.userA,
          FX.roleA,
        ]),
      ),
    );
    expect(state).toBe('OK');
  });
});

describe('golden/db: canonical legal entities never leak (rules 30, 33)', () => {
  const byId = 'SELECT id FROM legal_entities WHERE id = $1';

  it('legal_entity_id without tenant context reveals nothing', async () => {
    const res = await inTenant(appPool, null, (c) => c.query(byId, [FX.entityA]));
    expect(res.rowCount).toBe(0);
    const all = await inTenant(appPool, null, (c) => c.query('SELECT id FROM legal_entities'));
    expect(all.rowCount).toBe(0);
  });

  it('tenant A sees its own linked entity but not B’s', async () => {
    const own = await inTenant(appPool, FX.tenantA, (c) => c.query(byId, [FX.entityA]));
    const foreign = await inTenant(appPool, FX.tenantA, (c) => c.query(byId, [FX.entityB]));
    expect(own.rowCount).toBe(1);
    expect(foreign.rowCount).toBe(0);
  });
});

describe('golden/db: the app cannot write platform tables', () => {
  const writes: Record<string, string> = {
    legal_entities: `INSERT INTO legal_entities (country_code, tax_id, legal_name, normalized_name, timezone)
                     VALUES ('XX', 'APP-WRITE', 'x', 'x', 'UTC')`,
    jurisdiction_profiles: `INSERT INTO jurisdiction_profiles (country_code, default_currency, default_locale, default_timezone)
                            VALUES ('ZZ', 'EUR', 'en', 'UTC')`,
    exchange_rates: `INSERT INTO exchange_rates (source, base_currency, quote_currency, rate, valid_on)
                     VALUES ('ECB', 'EUR', 'RSD', 117, '2026-01-01')`,
    pii_field_registry: `UPDATE pii_field_registry SET pii_class = 'P0'`,
    permissions: `INSERT INTO permissions (key) VALUES ('golden.write')`,
    platform_feature_flags: `UPDATE platform_feature_flags SET enabled = true`,
    tenants: `UPDATE tenants SET display_name = 'renamed'`,
  };

  for (const [table, sql] of Object.entries(writes)) {
    it(`${table}: write as vigor_app is denied`, async () => {
      const state = await inTenant(appPool, FX.tenantA, (c) => sqlState(c.query(sql)));
      expect(state).toBe('42501');
    });
  }
});
