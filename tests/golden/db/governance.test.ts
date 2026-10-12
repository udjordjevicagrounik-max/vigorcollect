import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseMasterKeyring } from '@/server/crypto/keyring';
import { createConsumer } from '@/server/customers/repository';
import { ensureFixtures, FX } from './fixtures';
import { appPool, closePools, inTenant, migratePool, savepointState } from './helpers';

// Golden (never delete or skip): maker-checker (rule 11), human approval of legal-effect
// decisions on natural persons (rule 19) and the INSERT-only export log (rule 12).

const keyring = parseMasterKeyring(`1:${randomBytes(32).toString('base64')}`);

beforeAll(ensureFixtures);
afterAll(closePools);

async function request(c: PoolClient): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO approval_requests (tenant_id, action_type, entity_type, entity_id, payload, requested_by)
     VALUES ($1, 'customer.block', 'customers', $2, jsonb_build_object('customer_id', $2::uuid), $3)
     RETURNING id`,
    [FX.tenantA, FX.customerA, FX.userA],
  );
  return rows[0]?.id ?? '';
}

const DECIDE = `UPDATE approval_requests SET status = 'approved', decided_by = $2, decided_at = now()
                WHERE id = $1`;

describe('golden/db: approval_requests (maker-checker)', () => {
  it('the maker can never approve their own request; another user can', async () => {
    const self = await inTenant(appPool, FX.tenantA, async (c) =>
      savepointState(c, DECIDE, [await request(c), FX.userA]),
    );
    const checker = await inTenant(appPool, FX.tenantA, async (c) =>
      savepointState(c, DECIDE, [await request(c), FX.userA2]),
    );
    expect([self, checker]).toEqual(['23514', 'OK']);
  });

  it('pending content is frozen and a decided request is final', async () => {
    const states = await inTenant(appPool, FX.tenantA, async (c) => {
      const id = await request(c);
      const payload = await savepointState(
        c,
        `UPDATE approval_requests SET payload = '{"limit": 1}' WHERE id = $1`,
        [id],
      );
      await c.query(DECIDE, [id, FX.userA2]);
      const reopen = await savepointState(
        c,
        `UPDATE approval_requests SET status = 'pending', decided_by = NULL, decided_at = NULL
           WHERE id = $1`,
        [id],
      );
      return { payload, reopen };
    });
    expect(states).toEqual({ payload: '23514', reopen: '23514' });
  });

  it('a checker from another tenant fails the composite FK', async () => {
    const state = await inTenant(appPool, FX.tenantA, async (c) =>
      savepointState(c, DECIDE, [await request(c), FX.userB]),
    );
    expect(state).toBe('23503');
  });
});

async function decision(
  c: PoolClient,
  customerId: string,
  approvedBy: string | null,
): Promise<string> {
  return savepointState(
    c,
    `INSERT INTO decisions (tenant_id, customer_id, decision_type, has_legal_effect, source,
                              source_ref, status, approved_by, approved_at)
       VALUES ($1, $2, 'credit_status_red', true, 'rule', 'golden.rule', 'approved', $3, now())`,
    [FX.tenantA, customerId, approvedBy],
  );
}

describe('golden/db: decisions (rule 19)', () => {
  it('natural person + legal effect: a rule cannot approve; a human approver can', async () => {
    const states = await inTenant(appPool, FX.tenantA, async (c) => {
      const { id } = await createConsumer(c, keyring, { displayName: 'Golden Consumer' });
      const byRule = await decision(c, id, null);
      const byHuman = await decision(c, id, FX.userA2);
      return { byRule, byHuman };
    });
    expect(states).toEqual({ byRule: '23514', byHuman: 'OK' });
  });

  it('a company may be decided by a rule (rule 19 applies to natural persons only)', async () => {
    const state = await inTenant(appPool, FX.tenantA, (c) => decision(c, FX.customerA, null));
    expect(state).toBe('OK');
  });

  it('a human proposer cannot approve their own decision; an approved decision is only superseded', async () => {
    const states = await inTenant(appPool, FX.tenantA, async (c) => {
      const self = await savepointState(
        c,
        `INSERT INTO decisions (tenant_id, customer_id, decision_type, source, proposed_by,
                                  status, approved_by, approved_at)
           VALUES ($1, $2, 'legal_handover', 'human', $3, 'approved', $3, now())`,
        [FX.tenantA, FX.customerA, FX.userA],
      );
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO decisions (tenant_id, customer_id, decision_type, source, proposed_by,
                                status, approved_by, approved_at)
         VALUES ($1, $2, 'legal_handover', 'human', $3, 'approved', $4, now()) RETURNING id`,
        [FX.tenantA, FX.customerA, FX.userA, FX.userA2],
      );
      const id = rows[0]?.id;
      const reject = await savepointState(
        c,
        `UPDATE decisions SET status = 'rejected', approved_at = NULL WHERE id = $1`,
        [id],
      );
      const supersede = await savepointState(
        c,
        `UPDATE decisions SET status = 'superseded' WHERE id = $1`,
        [id],
      );
      return { self, reject, supersede };
    });
    expect(states).toEqual({ self: '23514', reject: '23514', supersede: 'OK' });
  });
});

describe('golden/db: export_log is INSERT-only (rule 12)', () => {
  const INSERT = `INSERT INTO export_log (tenant_id, actor_type, actor_id, export_type, format, purpose, row_count)
                  VALUES ($1, 'user', $2, 'customers.list', 'csv', 'reporting', 2) RETURNING id`;

  it('vigor_app: SELECT and INSERT only', async () => {
    const { rows } = await appPool.query(
      `SELECT has_table_privilege('export_log', 'SELECT') AS sel,
              has_table_privilege('export_log', 'INSERT') AS ins,
              has_table_privilege('export_log', 'UPDATE') AS upd,
              has_table_privilege('export_log', 'DELETE') AS del,
              has_table_privilege('export_log', 'TRUNCATE') AS trunc`,
    );
    expect(rows).toEqual([{ sel: true, ins: true, upd: false, del: false, trunc: false }]);
  });

  it('append works; UPDATE and DELETE are denied', async () => {
    const states = await inTenant(appPool, FX.tenantA, async (c) => {
      const append = await savepointState(c, INSERT, [FX.tenantA, FX.userA]);
      const update = await savepointState(c, 'UPDATE export_log SET row_count = 0');
      const del = await savepointState(c, 'DELETE FROM export_log');
      return { append, update, del };
    });
    expect(states).toEqual({ append: 'OK', update: '42501', del: '42501' });
  });

  it('the trigger blocks even the owner (TRUNCATE ignores RLS, the trigger does not)', async () => {
    const state = await inTenant(migratePool, FX.tenantA, (c) =>
      savepointState(c, 'TRUNCATE export_log'),
    );
    expect(state).toBe('42501');
  });

  it('an export linked to another tenant’s grant fails the composite FK', async () => {
    const state = await inTenant(appPool, FX.tenantA, (c) =>
      savepointState(
        c,
        `INSERT INTO export_log (tenant_id, actor_type, export_type, format, purpose, row_count,
                                   access_grant_id)
           VALUES ($1, 'system', 'customers.list', 'csv', 'reporting', 0, $2)`,
        [FX.tenantA, '7b000000-0000-4000-8000-00000000000b'],
      ),
    );
    expect(state).toBe('23503');
  });
});
