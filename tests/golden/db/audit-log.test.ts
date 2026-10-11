import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureFixtures, FX } from './fixtures';
import { appPool, closePools, inTenant, migratePool, sqlState } from './helpers';

// Golden (never delete or skip): audit_log is INSERT-only (rule 6) — grants, RLS and trigger.

beforeAll(ensureFixtures);
afterAll(closePools);

describe('golden/db: audit_log is INSERT-only', () => {
  it('vigor_app has SELECT + INSERT but no UPDATE / DELETE / TRUNCATE', async () => {
    const { rows } = await appPool.query<Record<string, boolean>>(
      `SELECT has_table_privilege('audit_log', 'SELECT') AS select,
              has_table_privilege('audit_log', 'INSERT') AS insert,
              has_table_privilege('audit_log', 'UPDATE') AS update,
              has_table_privilege('audit_log', 'DELETE') AS delete,
              has_table_privilege('audit_log', 'TRUNCATE') AS truncate`,
    );
    expect(rows[0]).toEqual({
      select: true,
      insert: true,
      update: false,
      delete: false,
      truncate: false,
    });
  });

  it('vigor_app can append within its tenant', async () => {
    const state = await inTenant(appPool, FX.tenantA, (c) =>
      sqlState(
        c.query(
          `INSERT INTO audit_log (tenant_id, actor_type, action, entity_type)
           VALUES ($1, 'system', 'golden.append', 'tenants')`,
          [FX.tenantA],
        ),
      ),
    );
    expect(state).toBe('OK');
  });

  it('vigor_app UPDATE / DELETE are denied', async () => {
    const update = await inTenant(appPool, FX.tenantA, (c) =>
      sqlState(
        c.query("UPDATE audit_log SET action = 'golden.tampered' WHERE id = $1", [FX.auditA]),
      ),
    );
    const del = await inTenant(appPool, FX.tenantA, (c) =>
      sqlState(c.query('DELETE FROM audit_log WHERE id = $1', [FX.auditA])),
    );
    expect(update).toBe('42501');
    expect(del).toBe('42501');
  });

  it('even the owner cannot change rows: RLS has no UPDATE/DELETE policy (0 rows touched)', async () => {
    const res = await inTenant(migratePool, FX.tenantA, (c) =>
      c.query("UPDATE audit_log SET action = 'golden.tampered' WHERE id = $1", [FX.auditA]),
    );
    expect(res.rowCount).toBe(0);
  });

  it('trigger blocks UPDATE and DELETE even when RLS is lifted (owner, rolled back)', async () => {
    for (const sql of [
      "UPDATE audit_log SET action = 'golden.tampered' WHERE id = $1",
      'DELETE FROM audit_log WHERE id = $1',
    ]) {
      const state = await inTenant(migratePool, FX.tenantA, async (c) => {
        // Transactional DDL — rolled back by inTenant; only ever runs against collect_test.
        await c.query('ALTER TABLE audit_log NO FORCE ROW LEVEL SECURITY');
        return sqlState(c.query(sql, [FX.auditA]));
      });
      expect(state).toBe('42501');
    }
  });

  it('trigger blocks TRUNCATE (owner)', async () => {
    const state = await inTenant(migratePool, FX.tenantA, (c) =>
      sqlState(c.query('TRUNCATE audit_log')),
    );
    expect(state).toBe('42501');
  });

  it('the fixture row is still there, unchanged', async () => {
    const { rows } = await inTenant(appPool, FX.tenantA, (c) =>
      c.query<{ action: string }>('SELECT action FROM audit_log WHERE id = $1', [FX.auditA]),
    );
    expect(rows).toEqual([{ action: 'golden.fixture_created' }]);
  });
});
