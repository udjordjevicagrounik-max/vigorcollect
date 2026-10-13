import { randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { decideApproval } from '@/server/approvals/service';
import { writeAudit, type AuditEntry } from '@/server/auth/audit';
import { PermissionDeniedError } from '@/server/auth/permissions';
import type { TenantContext } from '@/server/auth/with-tenant';
import { parseMasterKeyring } from '@/server/crypto/keyring';
import { createConsumer } from '@/server/customers/repository';
import { submitRuleProposal } from '@/server/decisions/service';
import type { RiskProvider } from '@/server/risk/providers/types';
import { computeRisk, getRisk } from '@/server/risk/service';
import { ensureFixtures, FX } from './fixtures';
import { closePools, inTenant, inTenantCommit, migratePool } from './helpers';

// Golden (never delete or skip) — task 4.3 risk (rules 11, 19, 35):
//   - the score is deterministic and explained; weights come from tenant_settings;
//   - a band is only a PROPOSAL: credit_status changes after another person approves — natural
//     person through decision.approve (rule 19), company through customer.risk_override (rule 11);
//   - providers: a source without an API answers 'unsupported' (sync_runs), the cache is
//     respected (valid_until), data that may not be stored is not stored, no PII in the log;
//   - tenant isolation of scores.
// vigor_migrate is used where the test edits configuration (tenant_settings, a test country);
// FORCE RLS applies to it as well, everything is rolled back.

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

const jobAudit = (db: PoolClient) => (entry: AuditEntry) =>
  writeAudit(db, { type: 'job', id: null }, entry, null);

function ctxFor(db: PoolClient, userId: string = FX.userA): TenantContext {
  const requestId = randomUUID();
  return {
    db,
    tenantId: FX.tenantA,
    userId,
    authUserId: 'golden',
    requestId,
    requirePermission: async (key) => ({ key, scope: 'ORGANIZATION' }),
    requireAnyPermission: async (k) => ({ key: k[0] ?? '', scope: 'ORGANIZATION' }),
    audit: (entry) => writeAudit(db, { type: 'user', id: userId }, entry, requestId),
  };
}

async function company(db: PoolClient, country = 'XX', name = 'Risk Kupac'): Promise<string> {
  const le = await db.query<{ id: string }>(
    `SELECT find_or_create_legal_entity($1, $2, $3, 'UTC', NULL) AS id`,
    [country, `RK-${randomUUID().slice(0, 12)}`, name],
  );
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO customers (tenant_id, legal_entity_id, display_name, owner_user_id) VALUES ($1, $2, $3, $4) RETURNING id`,
    [FX.tenantA, le.rows[0]?.id, name, FX.userA],
  );
  return rows[0]?.id ?? '';
}

async function overdue(db: PoolClient, customerId: string, days: number): Promise<void> {
  await db.query(
    `INSERT INTO invoices (tenant_id, company_id, customer_id, source_id, external_id, number, issue_date, due_date,
                           currency, amount_total, amount_open)
     SELECT $1, $2, $3, s.id, $4, $4, (now() AT TIME ZONE 'UTC')::date - $5::int - 30,
            (now() AT TIME ZONE 'UTC')::date - $5::int, 'EUR', '1000.00', '1000.00'
     FROM data_sources s WHERE s.name = 'file-import'`,
    [FX.tenantA, FX.companyA, customerId, `RK-${randomUUID().slice(0, 8)}`, days],
  );
}

const noExternal = { external: false } as const;

describe('golden/db: risk score (4.3)', () => {
  it('is deterministic and explained; tenant weights change it; another tenant sees nothing', async () => {
    const out = await inTenant(migratePool, FX.tenantA, async (db) => {
      const c = await company(db);
      await overdue(db, c, 95);
      const audit = jobAudit(db);
      const now = new Date('2026-10-13T10:00:00Z');
      const a = await computeRisk(db, audit, c, { ...noExternal, now });
      const b = await computeRisk(db, audit, c, { ...noExternal, now });
      await db.query(
        `UPDATE tenant_settings SET risk_weights = '{"days_overdue": 10, "inactivity_days": 90}'::jsonb`,
      );
      const weighted = await computeRisk(db, audit, c, { ...noExternal, now });
      const view = await getRisk(ctxFor(db), c);
      await db.query("SELECT set_config('app.tenant_id', $1, true)", [FX.tenantB]);
      const fromB = await db.query('SELECT 1 FROM risk_scores WHERE customer_id = $1', [c]);
      return { a, b, weighted, view, fromB: fromB.rowCount };
    });
    expect(out.a.score).toBe(out.b.score);
    expect(out.a.explanation).toEqual(out.b.explanation);
    expect(out.a.explanation.contributions.find((x) => x.signal === 'days_overdue')).toMatchObject({
      value: 95,
      points: 100,
    });
    expect(out.weighted.score).not.toBe(out.a.score);
    expect(out.weighted.explanation.weights.days_overdue).toBe(10);
    expect(out.view.latest?.explanation.contributions).toHaveLength(6);
    expect(out.view.history).toHaveLength(3);
    expect(out.fromB).toBe(0);
  });

  it('natural person red: only a proposal; credit status changes after a HUMAN approves (rule 19)', async () => {
    const out = await inTenant(migratePool, FX.tenantA, async (db) => {
      const person = await createConsumer(db, keyring, { displayName: 'Risk Osoba' });
      await overdue(db, person.id, 120);
      await db.query(`UPDATE tenant_settings SET risk_band_yellow = 10, risk_band_red = 20`);
      const r = await computeRisk(db, jobAudit(db), person.id, noExternal);
      const before = await db.query<{ credit_status: string }>(
        'SELECT credit_status FROM customers WHERE id = $1',
        [person.id],
      );
      const d = await db.query<{ id: string; decision_type: string; has_legal_effect: boolean }>(
        `SELECT id, decision_type, has_legal_effect FROM decisions WHERE customer_id = $1 AND status = 'proposed'`,
        [person.id],
      );
      const again = await computeRisk(db, jobAudit(db), person.id, noExternal);
      const count = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM decisions WHERE customer_id = $1 AND decision_type LIKE 'credit%'`,
        [person.id],
      );
      const { approvalId } = await submitRuleProposal(ctxFor(db), d.rows[0]?.id ?? '');
      const req = await db.query<{ action_type: string }>(
        'SELECT action_type FROM approval_requests WHERE id = $1',
        [approvalId],
      );
      await decideApproval(ctxFor(db, FX.userA2), approvalId, { decision: 'approve' });
      const after = await db.query<{ credit_status: string }>(
        'SELECT credit_status FROM customers WHERE id = $1',
        [person.id],
      );
      const decided = await db.query<{ status: string; approved_by: string }>(
        'SELECT status, approved_by FROM decisions WHERE id = $1',
        [d.rows[0]?.id],
      );
      return {
        r,
        again: again.proposed,
        before: before.rows[0]?.credit_status,
        d: d.rows[0],
        count: count.rows[0]?.n,
        req: req.rows[0]?.action_type,
        after: after.rows[0]?.credit_status,
        decided: decided.rows[0],
      };
    });
    expect(out.r.band).toBe('red');
    expect(out.r.proposed).toBe(true);
    expect(out.before).toBe('unrated');
    expect(out.d).toMatchObject({ decision_type: 'credit_status_red', has_legal_effect: true });
    expect(out.again).toBe(false);
    expect(out.count).toBe(1);
    expect(out.req).toBe('decision.approve');
    expect(out.after).toBe('red');
    expect(out.decided).toEqual({ status: 'approved', approved_by: FX.userA2 });
  });

  it('company: the change goes through customer.risk_override, never by the maker (rule 11)', async () => {
    const out = await inTenant(migratePool, FX.tenantA, async (db) => {
      const c = await company(db);
      await overdue(db, c, 40);
      await computeRisk(db, jobAudit(db), c, noExternal);
      const d = await db.query<{ id: string; decision_type: string }>(
        `SELECT id, decision_type FROM decisions WHERE customer_id = $1 AND status = 'proposed'`,
        [c],
      );
      const { approvalId } = await submitRuleProposal(ctxFor(db), d.rows[0]?.id ?? '');
      const req = await db.query<{ action_type: string }>(
        'SELECT action_type FROM approval_requests WHERE id = $1',
        [approvalId],
      );
      const self = await decideApproval(ctxFor(db), approvalId, { decision: 'approve' }).catch(
        (e: unknown) => e,
      );
      const unchanged = await db.query<{ credit_status: string }>(
        'SELECT credit_status FROM customers WHERE id = $1',
        [c],
      );
      await decideApproval(ctxFor(db, FX.userA2), approvalId, { decision: 'approve' });
      const after = await db.query<{ credit_status: string }>(
        'SELECT credit_status FROM customers WHERE id = $1',
        [c],
      );
      return {
        type: d.rows[0]?.decision_type,
        req: req.rows[0]?.action_type,
        self,
        unchanged: unchanged.rows[0]?.credit_status,
        after: after.rows[0]?.credit_status,
      };
    });
    expect(out.type).toMatch(/^credit_status_(yellow|red|green)$/);
    expect(out.req).toBe('customer.risk_override');
    expect(out.self).toBeInstanceOf(PermissionDeniedError);
    expect(out.unchanged).toBe('unrated');
    expect(out.after).toBe(out.type?.replace('credit_status_', ''));
  });
});

describe('golden/db: risk providers (4.3, rule 35)', () => {
  it('stubs answer unsupported; cache by valid_until; no store without the right; no PII in the log', async () => {
    const calls: string[] = [];
    const fake = (key: RiskProvider['key'], mayStore: boolean): RiskProvider => ({
      key,
      sourceName: `golden_${key}`,
      sourceType: 'CREDIT_BUREAU',
      rights: {
        mayDisplay: true,
        mayStore,
        retentionDays: mayStore ? 30 : 0,
        mayDerive: true,
        mayRedistribute: false,
        mayOnwardShare: false,
      },
      fetch: async () => {
        calls.push(key);
        return {
          status: 'ok',
          signals: [{ type: 'external_blocked', value: 1, rawRef: null }],
          validForSeconds: 3600,
        };
      },
    });
    const lines: string[] = [];
    const spy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        return true;
      });
    const taxName = `Golden Rizik ${randomUUID().slice(0, 6)}`;
    const out = await inTenant(migratePool, FX.tenantA, async (db) => {
      await db.query(
        `INSERT INTO jurisdiction_profiles (country_code, default_currency, default_locale, default_timezone, risk_providers)
         VALUES ('XQ', 'EUR', 'en', 'UTC', ARRAY['checkpoint', 'apr', 'nbs'])`,
      );
      const c = await company(db, 'XQ', taxName);
      await overdue(db, c, 10);
      const audit = jobAudit(db);
      // Real adapters: APR / NBS have no public API, CheckPoint has no documented API (stubs).
      const real = await computeRisk(db, audit, c);
      const runs = await db.query<{ provider: string; status: string; error_code: string | null }>(
        `SELECT provider, status, error_code FROM sync_runs WHERE kind = 'risk.fetch' ORDER BY provider`,
      );
      // A provider with data: called once (cache), stored only where the source allows it.
      const providers = {
        checkpoint: fake('checkpoint', true),
        apr: fake('apr', false),
        nbs: fake('nbs', true),
      };
      const first = await computeRisk(db, audit, c, { providers });
      const second = await computeRisk(db, audit, c, { providers });
      const stored = await db.query<{ source: string; data_source_id: string | null }>(
        `SELECT source, data_source_id FROM risk_signals WHERE customer_id = $1 ORDER BY source`,
        [c],
      );
      const ds = await db.query<{ name: string; may_redistribute: boolean }>(
        `SELECT name, may_redistribute FROM data_sources WHERE name IN ('checkpoint', 'apr', 'nbs') ORDER BY name`,
      );
      return { real, runs: runs.rows, first, second, stored: stored.rows, ds: ds.rows };
    });
    spy.mockRestore();
    expect(
      out.real.explanation.contributions.find((x) => x.signal === 'external_blocked'),
    ).toMatchObject({ value: null });
    expect(out.runs.filter((r) => r.provider === 'apr' || r.provider === 'nbs')).toEqual([
      { provider: 'apr', status: 'unsupported', error_code: 'no_public_api' },
      { provider: 'nbs', status: 'unsupported', error_code: 'no_public_api' },
    ]);
    expect(out.runs.find((r) => r.provider === 'checkpoint')?.error_code).toMatch(
      /^(not_configured|api_not_documented)$/,
    );
    expect(out.ds).toEqual([
      { name: 'apr', may_redistribute: false },
      { name: 'checkpoint', may_redistribute: false },
      { name: 'nbs', may_redistribute: false },
    ]);
    // apr may not store → asked both times; checkpoint and nbs cached after the first call.
    expect(calls.sort()).toEqual(['apr', 'apr', 'checkpoint', 'nbs']);
    expect(out.stored.map((s) => s.source)).toEqual(['checkpoint', 'nbs']);
    expect(
      out.first.explanation.contributions.find((x) => x.signal === 'external_blocked'),
    ).toMatchObject({ value: 1, points: 100 });
    expect(out.second.score).toBe(out.first.score);
    const logged = lines.join('');
    expect(logged).toContain('"event":"risk.provider"');
    expect(logged).not.toContain(taxName);
  });
});
