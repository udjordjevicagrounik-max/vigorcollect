import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureFixtures, FX } from './fixtures';
import { appPool, closePools, inTenant, migratePool, sqlState } from './helpers';

// Golden (never delete or skip): find_or_create_legal_entity is the only app write path to
// legal_entities — exact match, returns only an id, reveals nothing (rules 30, 33).

beforeAll(ensureFixtures);
afterAll(closePools);

const CALL = 'SELECT find_or_create_legal_entity($1, $2, $3, $4) AS id';

async function call(tenantId: string | null, args: string[]) {
  return inTenant(appPool, tenantId, async (c) => {
    const { rows } = await c.query<{ id: string }>(CALL, args);
    const visible = await c.query('SELECT id FROM legal_entities WHERE id = $1', [rows[0]?.id]);
    return { id: rows[0]?.id, visible: visible.rowCount };
  });
}

describe('golden/db: find_or_create_legal_entity — definition', () => {
  it('SECURITY DEFINER, empty search_path, returns a single uuid (never a set)', async () => {
    const { rows } = await migratePool.query(
      `SELECT p.prosecdef, p.proretset, format_type(p.prorettype, NULL) AS returns, p.proconfig
       FROM pg_proc p WHERE p.proname = 'find_or_create_legal_entity'`,
    );
    expect(rows).toEqual([
      { prosecdef: true, proretset: false, returns: 'uuid', proconfig: ['search_path=""'] },
    ]);
  });

  it('EXECUTE: vigor_app yes, PUBLIC no', async () => {
    const { rows } = await migratePool.query(
      `SELECT has_function_privilege('vigor_app', p.oid, 'EXECUTE') AS app,
              EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0) AS public
       FROM pg_proc p WHERE p.proname = 'find_or_create_legal_entity'`,
    );
    expect(rows).toEqual([{ app: true, public: false }]);
  });
});

describe('golden/db: find_or_create_legal_entity — behaviour', () => {
  it('requires a tenant context', async () => {
    const state = await inTenant(appPool, null, (c) =>
      sqlState(c.query(CALL, ['XX', 'NO-CONTEXT', 'No Context', 'UTC'])),
    );
    expect(state).toBe('42501');
  });

  it('existing entity: returns its id, reveals no columns, does not make it visible', async () => {
    const res = await call(FX.tenantA, ['XX', 'GOLDEN-B', 'Overwrite Attempt', 'UTC']);
    expect(res).toEqual({ id: FX.entityB, visible: 0 });
  });

  it('never overwrites the canonical row with the caller’s data', async () => {
    await call(FX.tenantA, ['XX', 'GOLDEN-B', 'Overwrite Attempt', 'UTC']);
    const { rows } = await migratePool.query<{ legal_name: string }>(
      'SELECT legal_name FROM legal_entities WHERE id = $1',
      [FX.entityB],
    );
    expect(rows[0]?.legal_name).toBe('Golden golden-b');
  });

  it('exact match only: case, prefix and padding never resolve to an existing entity', async () => {
    for (const taxId of ['golden-b', 'GOLDEN', 'GOLDEN-B-1']) {
      const res = await call(FX.tenantA, ['XX', taxId, 'Other', 'UTC']);
      expect(res.id).toBeDefined();
      expect(res.id).not.toBe(FX.entityB);
    }
    const padded = await inTenant(appPool, FX.tenantA, (c) =>
      sqlState(c.query(CALL, ['XX', ' GOLDEN-B', 'Padded', 'UTC'])),
    );
    expect(padded).toBe('22023');
  });

  it('new entity: created once; a second call in the same transaction returns the same id', async () => {
    const ids = await inTenant(appPool, FX.tenantA, async (c) => {
      const args = ['XX', 'GOLDEN-NEW', 'Golden New', 'UTC'];
      const first = await c.query<{ id: string }>(CALL, args);
      const second = await c.query<{ id: string }>(CALL, args);
      return [first.rows[0]?.id, second.rows[0]?.id];
    });
    expect(ids[0]).toBeDefined();
    expect(ids[0]).toBe(ids[1]);
  });
});
