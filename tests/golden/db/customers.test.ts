import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseMasterKeyring } from '@/server/crypto/keyring';
import { createConsumer, readCustomerName } from '@/server/customers/repository';
import { ensureFixtures, FX } from './fixtures';
import { appPool, closePools, inTenant, sqlState } from './helpers';

// Golden (never delete or skip): customers as TenantPartyRelationship (rule 30), isolation of
// the shared canonical identity (rules 32, 33) and user_roles.scope (ADR 0002, decision 1).

beforeAll(ensureFixtures);
afterAll(closePools);

const entityById = 'SELECT id FROM legal_entities WHERE id = $1';
const keyring = parseMasterKeyring(`1:${randomBytes(32).toString('base64')}`);

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

describe('golden/db: consumers never get a canonical identity (ADR 0002, decision 4)', () => {
  it('a company without legal_entity_id is rejected', async () => {
    const state = await inTenant(appPool, FX.tenantA, (c) =>
      sqlState(
        c.query(
          `INSERT INTO customers (tenant_id, legal_entity_id, is_natural_person, display_name)
           VALUES ($1, NULL, false, 'No Identity d.o.o.')`,
          [FX.tenantA],
        ),
      ),
    );
    expect(state).toBe('23514');
  });

  it('createConsumer: no legal_entities row, legal_entity_id NULL, name only encrypted', async () => {
    const res = await inTenant(appPool, FX.tenantA, async (c) => {
      const { id } = await createConsumer(c, keyring, { displayName: 'Marija Potrošač' });
      const row = await c.query<{ legal_entity_id: string | null; display_name: string | null }>(
        'SELECT legal_entity_id, display_name FROM customers WHERE id = $1',
        [id],
      );
      const inserted = await c.query<{ n: number }>(
        `SELECT n_tup_ins::int AS n FROM pg_stat_xact_user_tables WHERE relname = 'legal_entities'`,
      );
      return {
        row: row.rows[0],
        legalEntityInserts: inserted.rows[0]?.n ?? 0,
        name: await readCustomerName(c, keyring, id),
      };
    });
    expect(res.row).toEqual({ legal_entity_id: null, display_name: null });
    expect(res.legalEntityInserts).toBe(0);
    expect(res.name).toBe('Marija Potrošač');
  });
});

describe('golden/db: customers.segment_code → code_lists', () => {
  it('unknown segment is rejected; a code from the tenant list is accepted', async () => {
    const res = await inTenant(appPool, FX.tenantA, async (c) => {
      const unknown = await sqlState(
        c.query(`UPDATE customers SET segment_code = 'vip' WHERE id = $1`, [FX.customerA]),
      );
      return unknown;
    });
    expect(res).toBe('23503');

    const ok = await inTenant(appPool, FX.tenantA, async (c) => {
      await c.query(
        `INSERT INTO code_lists (tenant_id, list_key, code) VALUES ($1, 'customer_segment', 'vip')`,
        [FX.tenantA],
      );
      return sqlState(
        c.query(`UPDATE customers SET segment_code = 'vip' WHERE id = $1`, [FX.customerA]),
      );
    });
    expect(ok).toBe('OK');
  });

  it('a segment code of another tenant’s list is rejected (composite FK)', async () => {
    const state = await inTenant(appPool, FX.tenantB, async (c) => {
      await c.query(
        `INSERT INTO code_lists (tenant_id, list_key, code) VALUES ($1, 'customer_segment', 'vip')`,
        [FX.tenantB],
      );
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [FX.tenantA]);
      return sqlState(
        c.query(`UPDATE customers SET segment_code = 'vip' WHERE id = $1`, [FX.customerA]),
      );
    });
    expect(state).toBe('23503');
  });
});
