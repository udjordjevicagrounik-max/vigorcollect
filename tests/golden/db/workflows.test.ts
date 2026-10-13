import { randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeAudit, type AuditEntry } from '@/server/auth/audit';
import { PermissionDeniedError } from '@/server/auth/permissions';
import type { TenantContext } from '@/server/auth/with-tenant';
import { createConsumer } from '@/server/customers/repository';
import { parseMasterKeyring } from '@/server/crypto/keyring';
import { tenantClockTick } from '@/server/jobs/clock';
import { runDailyWorkflows, runWorkflowsForEvent } from '@/server/workflows/engine';
import { createWorkflow, decidePublish, saveDraft, submitForPublish } from '@/server/workflows/service';
import { ensureFixtures, FX } from './fixtures';
import { appPool, closePools, inTenant, inTenantCommit, migratePool, savepointState } from './helpers';

// Golden (never delete or skip) — task 3.1 rule engine: a tenant's rules never touch another
// tenant; the same event (or the same local day) is one run; a natural person never gets an
// automatic decision (rule 19); publishing needs another person (rule 11 style maker-checker);
// a published version is immutable; a DST day does not double the daily trigger.

const keyring = parseMasterKeyring(`1:${randomBytes(32).toString('base64')}`);

beforeAll(async () => {
  await ensureFixtures();
  for (const t of [FX.tenantA, FX.tenantB]) {
    await inTenantCommit(migratePool, t, async (c) => {
      await c.query('SELECT provision_receivables_defaults()');
    });
  }
});
afterAll(closePools);

const jobAudit = (db: PoolClient) => (entry: AuditEntry) => writeAudit(db, { type: 'job', id: null }, entry, null);

function ctxFor(db: PoolClient, userId: string): TenantContext {
  const requestId = randomUUID();
  return {
    db,
    tenantId: FX.tenantA,
    userId,
    authUserId: 'golden',
    requestId,
    requirePermission: async (key) => ({ key, scope: 'ORGANIZATION' }),
    requireAnyPermission: async (keys) => ({ key: keys[0] ?? '', scope: 'ORGANIZATION' }),
    audit: (entry) => writeAudit(db, { type: 'user', id: userId }, entry, requestId),
  };
}

async function companyCustomer(db: PoolClient, tenantId: string): Promise<string> {
  const le = await db.query<{ id: string }>(
    `SELECT find_or_create_legal_entity('XX', $1, 'Golden rules', 'UTC', NULL) AS id`,
    [`WF-${randomUUID().slice(0, 12)}`],
  );
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO customers (tenant_id, legal_entity_id, display_name) VALUES ($1, $2, 'Golden rules') RETURNING id`,
    [tenantId, le.rows[0]?.id],
  );
  return rows[0]?.id ?? '';
}

/** Open invoice due `daysAgo` days before the company's (UTC) today. */
async function invoice(db: PoolClient, tenantId: string, companyId: string, customerId: string, daysAgo: number): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO invoices (tenant_id, company_id, customer_id, source_id, external_id, number, issue_date, due_date,
                           currency, amount_total, amount_open)
     SELECT $1, $2, $3, s.id, $4, $4, (now() AT TIME ZONE 'UTC')::date - $5::int - 30,
            (now() AT TIME ZONE 'UTC')::date - $5::int, 'EUR', '100.00', '100.00'
     FROM data_sources s WHERE s.name = 'file-import' RETURNING id`,
    [tenantId, companyId, customerId, `WF-${randomUUID().slice(0, 8)}`, daysAgo],
  );
  return rows[0]?.id ?? '';
}

const runsFor = (db: PoolClient, entityId: string) =>
  db
    .query<{ key: string; status: string; explanation: Record<string, unknown> }>(
      `SELECT w.key, r.status, r.explanation FROM workflow_runs r
       JOIN workflow_versions v ON v.id = r.workflow_version_id JOIN workflows w ON w.id = v.workflow_id
       WHERE r.entity_id = $1 ORDER BY w.key`,
      [entityId],
    )
    .then((r) => r.rows);

describe('golden/db: rule engine', () => {
  it('Standard D+7 opens a case with the version that leads it, explained', async () => {
    const out = await inTenant(appPool, FX.tenantA, async (db) => {
      const c = await companyCustomer(db, FX.tenantA);
      const inv = await invoice(db, FX.tenantA, FX.companyA, c, 7);
      const counts = await runDailyWorkflows(db, jobAudit(db));
      const k = await db.query<{ workflow_version_id: string | null; invoices: number }>(
        `SELECT k.workflow_version_id, (SELECT count(*) FROM case_invoices ci WHERE ci.case_id = k.id)::int AS invoices
         FROM collection_cases k WHERE k.customer_id = $1`,
        [c],
      );
      const actions = await db.query<{ action_type: string; status: string; result: Record<string, unknown> }>(
        `SELECT a.action_type, a.status, a.result FROM workflow_run_actions a
         JOIN workflow_runs r ON r.id = a.run_id WHERE r.entity_id = $1 ORDER BY a.position`,
        [inv],
      );
      return { counts, runs: await runsFor(db, inv), case: k.rows, actions: actions.rows };
    });
    expect(out.counts.succeeded).toBeGreaterThanOrEqual(1);
    expect(out.runs).toEqual([expect.objectContaining({ key: 'std_overdue_d7', status: 'succeeded' })]);
    expect(out.runs[0]?.explanation).toMatchObject({
      version: 1,
      matched: true,
      conditions: [{ field: 'policy', op: 'eq', expected: 'standard', actual: 'standard', ok: true }],
    });
    expect(out.case).toEqual([{ workflow_version_id: expect.any(String), invoices: 1 }]);
    expect(out.actions).toEqual([
      expect.objectContaining({ action_type: 'queue_email', status: 'skipped', result: expect.objectContaining({ reason: 'no_recipient' }) }),
      expect.objectContaining({ action_type: 'create_case', status: 'succeeded' }),
    ]);
  });

  it('tenant A’s rules never touch tenant B (and B sees none of A’s runs)', async () => {
    const out = await inTenant(appPool, FX.tenantB, async (db) => {
      const c = await companyCustomer(db, FX.tenantB);
      const invB = await invoice(db, FX.tenantB, FX.companyB, c, 7);
      await db.query("SELECT set_config('app.tenant_id', $1, true)", [FX.tenantA]);
      await runDailyWorkflows(db, jobAudit(db));
      const fromA = await db.query('SELECT 1 FROM workflow_runs WHERE entity_id = $1', [invB]);
      await db.query("SELECT set_config('app.tenant_id', $1, true)", [FX.tenantB]);
      const inB = await db.query(
        `SELECT 1 FROM workflow_runs r JOIN workflow_versions v ON v.id = r.workflow_version_id
         WHERE v.tenant_id <> $1`,
        [FX.tenantB],
      );
      return { fromA: fromA.rowCount, foreignVisible: inB.rowCount };
    });
    expect(out).toEqual({ fromA: 0, foreignVisible: 0 });
  });

  it('the same event twice is one run; the same local day twice is one run', async () => {
    const out = await inTenant(appPool, FX.tenantA, async (db) => {
      const c = await companyCustomer(db, FX.tenantA);
      const inv = await invoice(db, FX.tenantA, FX.companyA, c, 1);
      const ctx = ctxFor(db, FX.userA);
      // An event rule (draft → published by another person).
      const { id } = await createWorkflow(ctx, {
        name: 'Golden overdue event',
        definition: { trigger: { type: 'event', event: 'invoice.overdue' }, conditions: [], actions: [{ type: 'create_task', kind: 'call', dueInDays: 1 }] },
      });
      const { approvalId } = await submitForPublish(ctx, id);
      await decidePublish(ctxFor(db, FX.userA2), approvalId, { decision: 'approve' });
      const event = { id: randomUUID(), eventType: 'invoice.overdue', aggregateId: inv, payload: {} };
      const first = await runWorkflowsForEvent(db, jobAudit(db), event);
      const second = await runWorkflowsForEvent(db, jobAudit(db), event);
      const loop = await runWorkflowsForEvent(db, jobAudit(db), { ...event, id: randomUUID(), payload: { source: 'workflow' } });
      const d1 = await runDailyWorkflows(db, jobAudit(db));
      const d2 = await runDailyWorkflows(db, jobAudit(db));
      const tasks = await db.query('SELECT 1 FROM tasks WHERE customer_id = $1', [c]);
      return { first, second, loop, d1, d2, tasks: tasks.rowCount };
    });
    expect(out.first.succeeded).toBe(1);
    expect(out.second).toMatchObject({ succeeded: 0, duplicate: 1 });
    expect(out.loop).toMatchObject({ succeeded: 0, duplicate: 0 });
    expect(out.d1.succeeded).toBeGreaterThanOrEqual(1);
    expect(out.d2.succeeded + out.d2.skipped + out.d2.failed).toBe(0);
    expect(out.tasks).toBe(1);
  });

  it('a natural person never gets an automatic decision (rule 19): only a proposal', async () => {
    const out = await inTenant(appPool, FX.tenantA, async (db) => {
      const person = await createConsumer(db, keyring, { displayName: 'Golden Person' });
      const inv = await invoice(db, FX.tenantA, FX.companyA, person.id, 60);
      await runDailyWorkflows(db, jobAudit(db));
      const decisions = await db.query<{ status: string; source: string; approved_by: string | null }>(
        'SELECT status, source, approved_by FROM decisions WHERE customer_id = $1',
        [person.id],
      );
      const forced = await savepointState(
        db,
        `UPDATE decisions SET status = 'approved', approved_at = now() WHERE customer_id = $1`,
        [person.id],
      );
      return { runs: await runsFor(db, inv), decisions: decisions.rows, forced };
    });
    expect(out.runs.map((r) => [r.key, r.status])).toEqual([
      ['std_pre_litigation_company', 'skipped'],
      ['std_pre_litigation_person', 'succeeded'],
    ]);
    expect(out.decisions).toEqual([{ status: 'proposed', source: 'rule', approved_by: null }]);
    expect(out.forced).toBe('23514');
  });

  it('publishing needs another person; a published version is immutable', async () => {
    const out = await inTenant(appPool, FX.tenantA, async (db) => {
      const ctx = ctxFor(db, FX.userA);
      const def = { trigger: { type: 'no_activity' as const, days: 10 }, conditions: [], actions: [{ type: 'escalate' as const }] };
      const { id } = await createWorkflow(ctx, { name: 'Golden publish', definition: def });
      const { approvalId } = await submitForPublish(ctx, id);
      const self = await decidePublish(ctx, approvalId, { decision: 'approve' }).catch((e: unknown) => e);
      const direct = await savepointState(
        db,
        `UPDATE workflow_versions SET status = 'published', published_at = now(), approval_request_id = NULL
         WHERE workflow_id = $1`,
        [id],
      );
      await decidePublish(ctxFor(db, FX.userA2), approvalId, { decision: 'approve' });
      const mutate = await savepointState(db, `UPDATE workflow_versions SET definition = '{}' WHERE workflow_id = $1`, [id]);
      const next = await saveDraft(ctx, id, { definition: { ...def, trigger: { type: 'no_activity', days: 20 } } });
      const versions = await db.query<{ version: number; status: string }>(
        'SELECT version, status FROM workflow_versions WHERE workflow_id = $1 ORDER BY version',
        [id],
      );
      return { self, direct, mutate, next, versions: versions.rows };
    });
    expect(out.self).toBeInstanceOf(PermissionDeniedError);
    expect(out.direct).toBe('23514');
    expect(out.mutate).toBe('23514');
    expect(out.next).toEqual({ version: 2 });
    expect(out.versions).toEqual([
      { version: 1, status: 'published' },
      { version: 2, status: 'draft' },
    ]);
  });

  it('a DST day enqueues the daily trigger once per tenant and local date', async () => {
    // Europe/Belgrade leaves summer time on 2026-10-25 (03:00 → 02:00): a 25-hour local day.
    const ids = new Set<string>();
    const fakePool = {
      query: async () => ({ rows: [{ tenant_id: FX.tenantA, timezone: 'Europe/Belgrade' }] }),
    } as unknown as Parameters<typeof tenantClockTick>[0];
    for (let m = 0; m < 32 * 60; m += 15) {
      const now = new Date(Date.UTC(2026, 9, 24, 22, 0) + m * 60_000); // 2026-10-25 00:00 local, 32 h of ticks
      await tenantClockTick(fakePool, now, async (id) => {
        ids.add(id);
        return true;
      });
    }
    // Local dates seen after 06:00: 2026-10-25 and (late ticks) 2026-10-26 — never twice the same.
    expect(ids.size).toBe(2);
  });
});
