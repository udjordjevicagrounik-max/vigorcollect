import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureFixtures, FX, FX_PERMISSION } from './fixtures';
import { appPool, closePools, inTenant, savepointState, sqlState } from './helpers';

// Golden (never delete or skip): sharing across tenant boundaries only through access_grants
// (rule 34) and data source rights (rule 35). Everything runs as vigor_app and is rolled back.

beforeAll(ensureFixtures);
afterAll(closePools);

async function party(c: PoolClient, tenantId: string): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO external_parties (tenant_id, party_type, display_name, country_code)
     VALUES ($1, 'LAW_FIRM', 'Golden Law Office', 'XX') RETURNING id`,
    [tenantId],
  );
  return rows[0]?.id ?? '';
}

type GrantOverrides = Partial<{
  partyId: string;
  permissionKeys: string[];
  validUntil: string;
  batchId: string | null;
}>;

async function grant(c: PoolClient, partyId: string, o: GrantOverrides = {}): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO access_grants (tenant_id, external_party_id, grant_batch_id, purpose, resource_type,
                                resource_id, permission_keys, valid_from, valid_until, requested_by)
     VALUES ($1, $2, $3, 'legal_handover', 'customer', $4, $5, now(), $6::timestamptz, $7)
     RETURNING id`,
    [
      FX.tenantA,
      o.partyId ?? partyId,
      o.batchId ?? null,
      FX.customerA,
      o.permissionKeys ?? [FX_PERMISSION],
      o.validUntil ?? '2099-01-01T00:00:00Z',
      FX.userA,
    ],
  );
  return rows[0]?.id ?? '';
}

const APPROVE = `UPDATE access_grants SET status = 'active', approved_by = $2, approved_at = now()
                 WHERE id = $1`;

describe('golden/db: access_grants — isolation and integrity', () => {
  it('a grant is visible to its owner tenant only', async () => {
    const counts = await inTenant(appPool, FX.tenantA, async (c) => {
      await grant(c, await party(c, FX.tenantA));
      const own = await c.query('SELECT id FROM access_grants');
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [FX.tenantB]);
      const other = await c.query('SELECT id FROM access_grants');
      return [own.rowCount, other.rowCount];
    });
    expect(counts).toEqual([1, 0]);
  });

  it('a grant to another tenant’s party fails the composite FK', async () => {
    const state = await inTenant(appPool, FX.tenantB, async (c) => {
      const partyOfB = await party(c, FX.tenantB);
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [FX.tenantA]);
      return sqlState(grant(c, partyOfB));
    });
    expect(state).toBe('23503');
  });

  it('unknown permission keys and an empty period are rejected', async () => {
    const unknown = await inTenant(appPool, FX.tenantA, async (c) =>
      sqlState(grant(c, await party(c, FX.tenantA), { permissionKeys: ['customer.nuke'] })),
    );
    const period = await inTenant(appPool, FX.tenantA, async (c) =>
      sqlState(grant(c, await party(c, FX.tenantA), { validUntil: '2000-01-01T00:00:00Z' })),
    );
    expect(unknown).toBe('23503');
    expect(period).toBe('23514');
  });

  it('active needs an approver, and the approver is never the requester (four eyes)', async () => {
    const noApprover = await inTenant(appPool, FX.tenantA, async (c) => {
      const id = await grant(c, await party(c, FX.tenantA));
      return savepointState(c, `UPDATE access_grants SET status = 'active' WHERE id = $1`, [id]);
    });
    const self = await inTenant(appPool, FX.tenantA, async (c) => {
      const id = await grant(c, await party(c, FX.tenantA));
      return savepointState(c, APPROVE, [id, FX.userA]);
    });
    const checker = await inTenant(appPool, FX.tenantA, async (c) => {
      const id = await grant(c, await party(c, FX.tenantA));
      return savepointState(c, APPROVE, [id, FX.userA2]);
    });
    expect([noApprover, self, checker]).toEqual(['23514', '23514', 'OK']);
  });

  it('a decided grant is frozen: no new resource, no extension; only shrink or revoke', async () => {
    const states = await inTenant(appPool, FX.tenantA, async (c) => {
      const id = await grant(c, await party(c, FX.tenantA));
      await c.query(APPROVE, [id, FX.userA2]);
      const widen = await savepointState(
        c,
        'UPDATE access_grants SET resource_id = $2 WHERE id = $1',
        [id, FX.customerB],
      );
      const extend = await savepointState(
        c,
        `UPDATE access_grants SET valid_until = '2199-01-01' WHERE id = $1`,
        [id],
      );
      const shrink = await savepointState(
        c,
        `UPDATE access_grants SET valid_until = '2098-01-01' WHERE id = $1`,
        [id],
      );
      const noReason = await savepointState(
        c,
        `UPDATE access_grants SET status = 'revoked', revoked_by = $2, revoked_at = now() WHERE id = $1`,
        [id, FX.userA],
      );
      const revoke = await savepointState(
        c,
        `UPDATE access_grants SET status = 'revoked', revoked_by = $2, revoked_at = now(),
                  revoke_reason = 'case closed' WHERE id = $1`,
        [id, FX.userA],
      );
      const reopen = await savepointState(
        c,
        `UPDATE access_grants SET status = 'active' WHERE id = $1`,
        [id],
      );
      return { widen, extend, shrink, noReason, revoke, reopen };
    });
    expect(states).toEqual({
      widen: '23514',
      extend: '23514',
      shrink: 'OK',
      noReason: '23514',
      revoke: 'OK',
      reopen: '23514',
    });
  });

  it('grant_batch_id revokes several one-resource grants together', async () => {
    const revoked = await inTenant(appPool, FX.tenantA, async (c) => {
      const p = await party(c, FX.tenantA);
      const batchId = '7a000000-0000-4000-8000-00000000000a';
      for (const id of [await grant(c, p, { batchId }), await grant(c, p, { batchId })]) {
        await c.query(APPROVE, [id, FX.userA2]);
      }
      const res = await c.query(
        `UPDATE access_grants SET status = 'revoked', revoked_by = $2, revoked_at = now(),
                revoke_reason = 'mandate ended' WHERE grant_batch_id = $1`,
        [batchId, FX.userA],
      );
      return res.rowCount;
    });
    expect(revoked).toBe(2);
  });

  it('the app cannot delete grants or parties (history)', async () => {
    const grants = await inTenant(appPool, FX.tenantA, (c) =>
      savepointState(c, 'DELETE FROM access_grants'),
    );
    const parties = await inTenant(appPool, FX.tenantA, (c) =>
      savepointState(c, 'DELETE FROM external_parties'),
    );
    expect([grants, parties]).toEqual(['42501', '42501']);
  });
});

describe('golden/db: data_sources rights default to the strictest value (rule 35)', () => {
  it('a new source may not display, store, derive, redistribute or share; deletes on termination', async () => {
    const row = await inTenant(appPool, FX.tenantA, async (c) => {
      const { rows } = await c.query(
        `INSERT INTO data_sources (tenant_id, name, source_type) VALUES ($1, 'Golden ERP', 'ERP')
         RETURNING may_display, may_store, retention_days, may_derive, may_redistribute,
                   may_onward_share, delete_on_termination`,
        [FX.tenantA],
      );
      return rows[0];
    });
    expect(row).toEqual({
      may_display: false,
      may_store: false,
      retention_days: 0,
      may_derive: false,
      may_redistribute: false,
      may_onward_share: false,
      delete_on_termination: true,
    });
  });

  it('retention without storage and onward sharing without redistribution are rejected', async () => {
    const retention = await inTenant(appPool, FX.tenantA, (c) =>
      savepointState(
        c,
        `INSERT INTO data_sources (tenant_id, name, source_type, retention_days)
           VALUES ($1, 'X', 'API', 30)`,
        [FX.tenantA],
      ),
    );
    expect(retention).toBe('23514');
    const onward = await inTenant(appPool, FX.tenantA, (c) =>
      savepointState(
        c,
        `INSERT INTO data_sources (tenant_id, name, source_type, may_onward_share)
           VALUES ($1, 'Y', 'API', true)`,
        [FX.tenantA],
      ),
    );
    expect(onward).toBe('23514');
  });
});
