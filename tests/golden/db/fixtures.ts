import { inTenantCommit, migratePool } from './helpers';

// Permanent, idempotent golden fixtures in collect_test (never in the dev database).
// Fixed ids so every run sees the same world. Inserted as vigor_migrate with SET LOCAL
// app.tenant_id per tenant — the same path the seed uses.
export const FX = {
  tenantA: '0a000000-0000-4000-8000-00000000000a',
  tenantB: '0b000000-0000-4000-8000-00000000000b',
  entityA: '1a000000-0000-4000-8000-00000000000a',
  entityB: '1b000000-0000-4000-8000-00000000000b',
  companyA: '2a000000-0000-4000-8000-00000000000a',
  companyB: '2b000000-0000-4000-8000-00000000000b',
  userA: '3a000000-0000-4000-8000-00000000000a',
  userB: '3b000000-0000-4000-8000-00000000000b',
  roleA: '4a000000-0000-4000-8000-00000000000a',
  roleB: '4b000000-0000-4000-8000-00000000000b',
  auditA: '5a000000-0000-4000-8000-00000000000a',
  // One canonical legal entity in BOTH portfolios (rule 30): a customer of A and of B.
  entityShared: '1c000000-0000-4000-8000-00000000000c',
  customerA: '6a000000-0000-4000-8000-00000000000a',
  customerB: '6b000000-0000-4000-8000-00000000000b',
  // Second user of A: checker for maker-checker tests (maker ≠ checker).
  userA2: '3a000000-0000-4000-8000-0000000000a2',
} as const;

/** Permission used by access_grants tests (platform catalog). */
export const FX_PERMISSION = 'customer.read';

type TenantFixture = {
  tenantId: string;
  slug: string;
  entityId: string;
  taxId: string;
  companyId: string;
  userId: string;
  email: string;
  roleId: string;
  customerId: string;
};

const TENANTS: TenantFixture[] = [
  {
    tenantId: FX.tenantA,
    slug: 'golden-a',
    entityId: FX.entityA,
    taxId: 'GOLDEN-A',
    companyId: FX.companyA,
    userId: FX.userA,
    email: 'user-a@golden.example.test',
    roleId: FX.roleA,
    customerId: FX.customerA,
  },
  {
    tenantId: FX.tenantB,
    slug: 'golden-b',
    entityId: FX.entityB,
    taxId: 'GOLDEN-B',
    companyId: FX.companyB,
    userId: FX.userB,
    email: 'user-b@golden.example.test',
    roleId: FX.roleB,
    customerId: FX.customerB,
  },
];

let ready: Promise<void> | undefined;

export function ensureFixtures(): Promise<void> {
  ready ??= createFixtures();
  return ready;
}

async function createFixtures(): Promise<void> {
  await inTenantCommit(migratePool, null, async (c) => {
    await c.query(
      `INSERT INTO jurisdiction_profiles (country_code, default_currency, default_locale, default_timezone)
       VALUES ('XX', 'EUR', 'en', 'UTC') ON CONFLICT (country_code) DO NOTHING`,
    );
    for (const t of TENANTS) {
      await c.query(
        `INSERT INTO legal_entities (id, country_code, tax_id, legal_name, normalized_name, timezone)
         VALUES ($1, 'XX', $2, $3, $4, 'UTC') ON CONFLICT (id) DO NOTHING`,
        [t.entityId, t.taxId, `Golden ${t.slug}`, `golden ${t.slug}`],
      );
    }
    await c.query(
      `INSERT INTO legal_entities (id, country_code, tax_id, legal_name, normalized_name, timezone)
       VALUES ($1, 'XX', 'GOLDEN-SHARED', 'Golden Shared', 'golden shared', 'UTC')
       ON CONFLICT (id) DO NOTHING`,
      [FX.entityShared],
    );
    await c.query('INSERT INTO permissions (key) VALUES ($1) ON CONFLICT (key) DO NOTHING', [
      FX_PERMISSION,
    ]);
  });

  for (const t of TENANTS) {
    await inTenantCommit(migratePool, t.tenantId, async (c) => {
      await c.query(
        `INSERT INTO tenants (id, slug, display_name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
        [t.tenantId, t.slug, `Golden ${t.slug}`],
      );
      await c.query(
        `INSERT INTO tenant_settings (tenant_id, timezone, default_currency, country_code)
         VALUES ($1, 'UTC', 'EUR', 'XX') ON CONFLICT (tenant_id) DO NOTHING`,
        [t.tenantId],
      );
      await c.query(
        `INSERT INTO tenant_companies (id, tenant_id, legal_entity_id, display_name, is_default)
         VALUES ($1, $2, $3, $4, true) ON CONFLICT (id) DO NOTHING`,
        [t.companyId, t.tenantId, t.entityId, `Golden ${t.slug}`],
      );
      await c.query(
        `INSERT INTO users (id, tenant_id, email, display_name, timezone, status)
         VALUES ($1, $2, $3, $4, 'UTC', 'active') ON CONFLICT (id) DO NOTHING`,
        [t.userId, t.tenantId, t.email, `Golden user ${t.slug}`],
      );
      await c.query(
        `INSERT INTO roles (id, tenant_id, key, is_system) VALUES ($1, $2, 'golden_role', true)
         ON CONFLICT (id) DO NOTHING`,
        [t.roleId, t.tenantId],
      );
      await c.query(
        `INSERT INTO customers (id, tenant_id, legal_entity_id, display_name)
         VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
        [t.customerId, t.tenantId, FX.entityShared, `Shared customer of ${t.slug}`],
      );
    });
  }

  await inTenantCommit(migratePool, FX.tenantA, async (c) => {
    await c.query(
      `INSERT INTO users (id, tenant_id, email, display_name, timezone, status)
       VALUES ($1, $2, 'checker-a@golden.example.test', 'Golden checker A', 'UTC', 'active')
       ON CONFLICT (id) DO NOTHING`,
      [FX.userA2, FX.tenantA],
    );
    await c.query(
      `INSERT INTO audit_log (id, tenant_id, actor_type, action, entity_type, entity_id)
       VALUES ($1, $2, 'system', 'golden.fixture_created', 'tenants', $2)
       ON CONFLICT (id) DO NOTHING`,
      [FX.auditA, FX.tenantA],
    );
  });
}
