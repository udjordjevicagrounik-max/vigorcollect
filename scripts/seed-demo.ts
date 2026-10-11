/**
 * Deterministic demo seed (rule 24). Generated data only — never real data; e-mail addresses use
 * the reserved `.example` TLD so nothing can be delivered.
 *
 * Runs as vigor_migrate (MIGRATE_DATABASE_URL). Every tenant-scoped write happens inside a
 * transaction with SET LOCAL app.tenant_id = <that tenant>, so FORCE RLS applies to the seed as
 * well. Idempotent: fixed ids + ON CONFLICT DO NOTHING; running it twice changes nothing.
 *
 * Creates (0.2a):
 *   - jurisdiction profile RS (reference data needed by tenant_settings)
 *   - tenant #0 (platform operator) and the demo tenant, each with settings, one company
 *     (canonical legal entity), one admin user and one system role
 *   - audit_log rows: tenant provisioning is a platform action → recorded under tenant #0
 *     (ADR 0002); user creation → recorded in the user's tenant
 *
 * TODO(1.6): customers, invoices etc. through the same services as manual actions, using `rng`
 * for every random value and `daysFromToday` for every business date.
 */
import { existsSync } from 'node:fs';
import { Client } from 'pg';

const SEED = 20260101;

/** Mulberry32 — tiny deterministic PRNG; the same SEED always yields the same data. */
export function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Calendar date (YYYY-MM-DD) offset from today in UTC — `date` semantics, not a timestamp. */
export function daysFromToday(offset: number, today: Date = new Date()): string {
  const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

type DemoTenant = {
  tenantId: string;
  slug: string;
  displayName: string;
  isPlatformOperator: boolean;
  locale: string;
  legalEntityId: string;
  taxId: string;
  registrationNumber: string;
  companyId: string;
  userId: string;
  email: string;
  userName: string;
  roleId: string;
  provisionAuditId: string;
  userAuditId: string;
};

// Fixed ids: the demo world is identical on every machine.
const PLATFORM_OPERATOR: DemoTenant = {
  tenantId: '00000000-0000-4000-8000-000000000000',
  slug: 'sinergista',
  displayName: 'Sinergista',
  isPlatformOperator: true,
  locale: 'sr-Latn',
  legalEntityId: '00000000-0000-4000-8000-000000000e00',
  taxId: 'DEMO-000000000',
  registrationNumber: 'DEMO-00000000',
  companyId: '00000000-0000-4000-8000-000000000c00',
  userId: '00000000-0000-4000-8000-000000000a00',
  email: 'admin@sinergista.example',
  userName: 'Platform Admin',
  roleId: '00000000-0000-4000-8000-000000000b00',
  provisionAuditId: '00000000-0000-4000-8000-0000000a0000',
  userAuditId: '00000000-0000-4000-8000-0000000a0001',
};

const DEMO_TENANT: DemoTenant = {
  tenantId: 'd0000000-0000-4000-8000-000000000001',
  slug: 'demo',
  displayName: 'Demo Company',
  isPlatformOperator: false,
  locale: 'en',
  legalEntityId: 'd0000000-0000-4000-8000-000000000e01',
  taxId: 'DEMO-000000001',
  registrationNumber: 'DEMO-00000001',
  companyId: 'd0000000-0000-4000-8000-000000000c01',
  userId: 'd0000000-0000-4000-8000-000000000a01',
  email: 'admin@demo.example',
  userName: 'Demo Admin',
  roleId: 'd0000000-0000-4000-8000-000000000b01',
  provisionAuditId: 'd0000000-0000-4000-8000-0000000a0000',
  userAuditId: 'd0000000-0000-4000-8000-0000000a0001',
};

const COUNTRY = 'RS';
const TIMEZONE = 'Europe/Belgrade';
const CURRENCY = 'RSD';

function loadEnv(): void {
  if (!process.env.MIGRATE_DATABASE_URL && existsSync('.env')) process.loadEnvFile('.env');
}

async function inTenant(
  client: Client,
  tenantId: string | null,
  fn: () => Promise<void>,
): Promise<void> {
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

async function seedPlatform(client: Client): Promise<void> {
  await inTenant(client, null, async () => {
    await client.query(
      `INSERT INTO jurisdiction_profiles (country_code, default_currency, default_locale, default_timezone)
       VALUES ($1, $2, 'sr-Latn', $3) ON CONFLICT (country_code) DO NOTHING`,
      [COUNTRY, CURRENCY, TIMEZONE],
    );
    for (const t of [PLATFORM_OPERATOR, DEMO_TENANT]) {
      await client.query(
        `INSERT INTO legal_entities (id, country_code, tax_id, registration_number, legal_name,
                                     normalized_name, timezone, city, address_country_code)
         VALUES ($1, $2, $3, $4, $5, lower($5), $6, 'Beograd', $2)
         ON CONFLICT (id) DO NOTHING`,
        [t.legalEntityId, COUNTRY, t.taxId, t.registrationNumber, t.displayName, TIMEZONE],
      );
    }
  });
}

async function seedTenant(client: Client, t: DemoTenant): Promise<void> {
  await inTenant(client, t.tenantId, async () => {
    await client.query(
      `INSERT INTO tenants (id, slug, display_name, is_platform_operator)
       VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
      [t.tenantId, t.slug, t.displayName, t.isPlatformOperator],
    );
    await client.query(
      `INSERT INTO tenant_settings (tenant_id, default_locale, timezone, default_currency, country_code)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (tenant_id) DO NOTHING`,
      [t.tenantId, t.locale, TIMEZONE, CURRENCY, COUNTRY],
    );
    await client.query(
      `INSERT INTO tenant_companies (id, tenant_id, legal_entity_id, display_name, is_default)
       VALUES ($1, $2, $3, $4, true) ON CONFLICT (id) DO NOTHING`,
      [t.companyId, t.tenantId, t.legalEntityId, t.displayName],
    );
    await client.query(
      `INSERT INTO users (id, tenant_id, email, display_name, locale, timezone, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'active') ON CONFLICT (id) DO NOTHING`,
      [t.userId, t.tenantId, t.email, t.userName, t.locale, TIMEZONE],
    );
    await client.query(
      `INSERT INTO roles (id, tenant_id, key, is_system) VALUES ($1, $2, 'tenant_admin', true)
       ON CONFLICT (id) DO NOTHING`,
      [t.roleId, t.tenantId],
    );
    await client.query(
      `INSERT INTO user_roles (tenant_id, user_id, role_id) VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, user_id, role_id) DO NOTHING`,
      [t.tenantId, t.userId, t.roleId],
    );
    await client.query(
      `INSERT INTO audit_log (id, tenant_id, actor_type, action, entity_type, entity_id, after)
       VALUES ($1, $2, 'system', 'user.created', 'users', $3, jsonb_build_object('seed', true))
       ON CONFLICT (id) DO NOTHING`,
      [t.userAuditId, t.tenantId, t.userId],
    );
  });

  // Tenant provisioning is a platform action → audited under tenant #0 (ADR 0002).
  await inTenant(client, PLATFORM_OPERATOR.tenantId, async () => {
    await client.query(
      `INSERT INTO audit_log (id, tenant_id, actor_type, action, entity_type, entity_id, after)
       VALUES ($1, $2, 'system', 'tenant.provisioned', 'tenants', $3, jsonb_build_object('seed', true))
       ON CONFLICT (id) DO NOTHING`,
      [t.provisionAuditId, PLATFORM_OPERATOR.tenantId, t.tenantId],
    );
  });
}

async function main(): Promise<void> {
  loadEnv();
  const url = process.env.MIGRATE_DATABASE_URL;
  if (!url) throw new Error('MIGRATE_DATABASE_URL is not set (vigor_migrate connection string).');

  const rng = createRng(SEED);
  void rng; // reserved for generated business data (1.6)

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await seedPlatform(client);
    // Tenant #0 first: it must exist before platform actions can be audited under it.
    await seedTenant(client, PLATFORM_OPERATOR);
    await seedTenant(client, DEMO_TENANT);
    console.warn(`seed-demo: tenant #0 (${PLATFORM_OPERATOR.slug}) + ${DEMO_TENANT.slug} ready.`);
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
