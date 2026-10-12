import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureFixtures, FX } from './fixtures';
import { appPool, closePools, inTenant, sqlState } from './helpers';

// Golden (never delete or skip): customers as TenantPartyRelationship (rule 30), isolation of
// the shared canonical identity (rules 32, 33) and user_roles.scope (ADR 0002, decision 1).

beforeAll(ensureFixtures);
afterAll(closePools);

const entityById = 'SELECT id FROM legal_entities WHERE id = $1';

describe('golden/db: one legal entity in two portfolios', () => {
  it('both tenants see the shared entity through their own customer (app_read_linked)', async () => {
    const a = await inTenant(appPool, FX.tenantA, (c) => c.query(entityById, [FX.entityShared]));
    const b = await inTenant(appPool, FX.tenantB, (c) => c.query(entityById, [FX.entityShared]));
    expect(a.rowCount).toBe(1);
    expect(b.rowCount).toBe(1);
  });

  it('a customer link never widens visibility: A still does not see B’s own company entity', async () => {
    const res = await inTenant(appPool, FX.tenantA, (c) => c.query(entityById, [FX.entityB]));
    expect(res.rowCount).toBe(0);
  });

  it('WHERE legal_entity_id = X returns only the own tenant’s customer', async () => {
    const res = await inTenant(appPool, FX.tenantA, (c) =>
      c.query<{ id: string }>('SELECT id FROM customers WHERE legal_entity_id = $1', [
        FX.entityShared,
      ]),
    );
    expect(res.rows.map((r) => r.id)).toEqual([FX.customerA]);
  });

  it('without tenant context the shared entity and both customers are invisible', async () => {
    const entity = await inTenant(appPool, null, (c) => c.query(entityById, [FX.entityShared]));
    const customers = await inTenant(appPool, null, (c) => c.query('SELECT id FROM customers'));
    expect(entity.rowCount).toBe(0);
    expect(customers.rowCount).toBe(0);
  });
});

describe('golden/db: customers integrity', () => {
  it('a natural person with a plaintext name is rejected (rule 20, CHECK)', async () => {
    const state = await inTenant(appPool, FX.tenantA, (c) =>
      sqlState(
        c.query(
          `INSERT INTO customers (tenant_id, legal_entity_id, is_natural_person, display_name)
           VALUES ($1, $2, true, 'Plain Person')`,
          [FX.tenantA, FX.entityA],
        ),
      ),
    );
    expect(state).toBe('23514');
  });

  it('a company without a plaintext name is rejected', async () => {
    const state = await inTenant(appPool, FX.tenantA, (c) =>
      sqlState(
        c.query(
          `INSERT INTO customers (tenant_id, legal_entity_id, display_name_enc, display_name_key_version)
           VALUES ($1, $2, '\\x01', 1)`,
          [FX.tenantA, FX.entityA],
        ),
      ),
    );
    expect(state).toBe('23514');
  });

  it('owner from another tenant fails the composite FK', async () => {
    const state = await inTenant(appPool, FX.tenantA, (c) =>
      sqlState(
        c.query('UPDATE customers SET owner_user_id = $1 WHERE id = $2', [FX.userB, FX.customerA]),
      ),
    );
    expect(state).toBe('23503');
  });

  it('a contact of A pointing at B’s customer fails the composite FK', async () => {
    const state = await inTenant(appPool, FX.tenantA, (c) =>
      sqlState(
        c.query(
          `INSERT INTO customer_contacts (tenant_id, customer_id, name_enc, name_key_version)
           VALUES ($1, $2, '\\x01', 1)`,
          [FX.tenantA, FX.customerB],
        ),
      ),
    );
    expect(state).toBe('23503');
  });

  it('the app cannot delete customers or contacts (status only)', async () => {
    const customers = await inTenant(appPool, FX.tenantA, (c) =>
      sqlState(c.query('DELETE FROM customers WHERE id = $1', [FX.customerA])),
    );
    const contacts = await inTenant(appPool, FX.tenantA, (c) =>
      sqlState(c.query('DELETE FROM customer_contacts')),
    );
    expect(customers).toBe('42501');
    expect(contacts).toBe('42501');
  });
});

describe('golden/db: user_roles.scope', () => {
  it('defaults to OWN (narrowest) and accepts only OWN / TEAM / ORGANIZATION', async () => {
    const scope = await inTenant(appPool, FX.tenantA, async (c) => {
      const { rows } = await c.query<{ scope: string }>(
        'INSERT INTO user_roles (tenant_id, user_id, role_id) VALUES ($1, $2, $3) RETURNING scope',
        [FX.tenantA, FX.userA, FX.roleA],
      );
      return rows[0]?.scope;
    });
    expect(scope).toBe('OWN');

    const invalid = await inTenant(appPool, FX.tenantA, (c) =>
      sqlState(
        c.query(
          `INSERT INTO user_roles (tenant_id, user_id, role_id, scope) VALUES ($1, $2, $3, 'GLOBAL')`,
          [FX.tenantA, FX.userA, FX.roleA],
        ),
      ),
    );
    expect(invalid).toBe('23514');
  });
});
