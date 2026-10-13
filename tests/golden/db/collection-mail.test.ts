import { randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listAttention } from '@/server/attention/service';
import { decideApproval, listPendingApprovals } from '@/server/approvals/service';
import { writeAudit, type AuditEntry } from '@/server/auth/audit';
import { PermissionDeniedError } from '@/server/auth/permissions';
import type { TenantContext } from '@/server/auth/with-tenant';
import { parseMasterKeyring } from '@/server/crypto/keyring';
import { createConsumer, createContact } from '@/server/customers/repository';
import { submitRuleProposal } from '@/server/decisions/service';
import { EVENT_HANDLERS } from '@/server/jobs/handlers';
import { readOutbox } from '@/server/mail/adapter';
import { requestDailyRun } from '@/server/settings/daily-run';
import { runDailyWorkflows } from '@/server/workflows/engine';
import { ensureFixtures, FX } from './fixtures';
import { appPool, closePools, inTenant, inTenantCommit, migratePool } from './helpers';

// Golden (never delete or skip) — task 3.3:
//   - queue_email works end to end: Standard D+1 renders the template for the customer's mail
//     contact and writes it to mail_outbox (sink), encrypted; the run keeps ids only;
//   - a rule proposal becomes an approval request only when a PERSON submits it, and is decided
//     by ANOTHER person (rules 11 and 19) — legal handover and other decisions alike;
//   - "run the daily job now" is idempotent (a second run adds nothing).

const keyring = parseMasterKeyring(`1:${randomBytes(32).toString('base64')}`);
const EMAIL = 'golden.mail@example.test';

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
    requireAnyPermission: async (keys) => ({ key: keys[0] ?? '', scope: 'ORGANIZATION' }),
    audit: (entry) => writeAudit(db, { type: 'user', id: userId }, entry, requestId),
  };
}

async function company(db: PoolClient, name: string): Promise<string> {
  const le = await db.query<{ id: string }>(
    `SELECT find_or_create_legal_entity('XX', $1, $2, 'UTC', NULL) AS id`,
    [`CM-${randomUUID().slice(0, 12)}`, name],
  );
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO customers (tenant_id, legal_entity_id, display_name, owner_user_id) VALUES ($1, $2, $3, $4) RETURNING id`,
    [FX.tenantA, le.rows[0]?.id, name, FX.userA],
  );
  return rows[0]?.id ?? '';
}

/** userA (maker) holds decision.create + approval.create inside the (rolled back) test. */
async function grantMaker(db: PoolClient): Promise<void> {
  await db.query(
    `INSERT INTO user_roles (tenant_id, user_id, role_id, scope) VALUES ($1, $2, $3, 'ORGANIZATION')
     ON CONFLICT DO NOTHING`,
    [FX.tenantA, FX.userA, FX.roleA],
  );
  await db.query(
    `INSERT INTO role_permissions (tenant_id, role_id, permission_id)
     SELECT $1, $2, p.id FROM permissions p WHERE p.key IN ('decision.create', 'approval.create')
     ON CONFLICT DO NOTHING`,
    [FX.tenantA, FX.roleA],
  );
}

/** Open invoice due `daysAgo` days before the company's (UTC) today; returns id and number. */
async function invoice(
  db: PoolClient,
  customerId: string,
  daysAgo: number,
): Promise<{ id: string; number: string }> {
  const number = `CM-${randomUUID().slice(0, 8)}`;
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO invoices (tenant_id, company_id, customer_id, source_id, external_id, number, issue_date, due_date,
                           currency, amount_total, amount_open)
     SELECT $1, $2, $3, s.id, $4, $4, (now() AT TIME ZONE 'UTC')::date - $5::int - 30,
            (now() AT TIME ZONE 'UTC')::date - $5::int, 'EUR', '250.00', '250.00'
     FROM data_sources s WHERE s.name = 'file-import' RETURNING id`,
    [FX.tenantA, FX.companyA, customerId, number, daysAgo],
  );
  return { id: rows[0]?.id ?? '', number };
}

describe('golden/db: collection mail (queue_email → mail_outbox)', () => {
  it('Standard D+1 sends the reminder to the primary contact through the sink, encrypted', async () => {
    const out = await inTenant(appPool, FX.tenantA, async (db) => {
      const c = await company(db, 'Mail Golden d.o.o.');
      await createContact(db, keyring, {
        customerId: c,
        name: 'Kontakt Golden',
        email: EMAIL,
        isPrimary: true,
      });
      const inv = await invoice(db, c, 1);
      await runDailyWorkflows(db, jobAudit(db), { keyring });
      const row = await db.query<{
        kind: string;
        transport: string;
        status: string;
        customer_id: string;
        source_run_id: string | null;
        raw: string;
      }>(
        `SELECT kind, transport, status, customer_id, source_run_id,
                encode(recipient_enc, 'escape') || encode(body_enc, 'escape') AS raw
         FROM mail_outbox WHERE customer_id = $1`,
        [c],
      );
      const [mail] = await readOutbox(db, keyring, { kind: 'reminder', limit: 1 });
      const actions = await db.query<{ action_type: string; status: string; result: unknown }>(
        `SELECT a.action_type, a.status, a.result FROM workflow_run_actions a
         JOIN workflow_runs r ON r.id = a.run_id WHERE r.entity_id = $1`,
        [inv.id],
      );
      return { rows: row.rows, mail, actions: actions.rows, number: inv.number, c };
    });
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]).toMatchObject({
      kind: 'reminder',
      transport: 'sink',
      status: 'captured',
      customer_id: out.c,
      source_run_id: expect.any(String),
    });
    expect(out.rows[0]?.raw).not.toContain(EMAIL);
    expect(out.mail?.to).toBe(EMAIL);
    expect(out.mail?.subject).toContain(out.number);
    expect(out.mail?.html).toContain(out.number);
    expect(out.mail?.text).not.toContain('<p>');
    expect(out.actions).toEqual([
      expect.objectContaining({ action_type: 'queue_email', status: 'succeeded' }),
    ]);
    // The run stores ids only — never the address.
    expect(JSON.stringify(out.actions)).not.toContain('@');
  });

  it('without a mail contact the action is skipped (no_recipient), nothing is queued', async () => {
    const out = await inTenant(appPool, FX.tenantA, async (db) => {
      const c = await company(db, 'No Contact d.o.o.');
      const inv = await invoice(db, c, 1);
      await runDailyWorkflows(db, jobAudit(db), { keyring });
      const mail = await db.query('SELECT 1 FROM mail_outbox WHERE customer_id = $1', [c]);
      const a = await db.query<{ result: { reason: string } }>(
        `SELECT a.result FROM workflow_run_actions a JOIN workflow_runs r ON r.id = a.run_id WHERE r.entity_id = $1`,
        [inv.id],
      );
      return { mail: mail.rowCount, reasons: a.rows.map((r) => r.result.reason) };
    });
    expect(out).toEqual({ mail: 0, reasons: ['no_recipient'] });
  });
});

describe('golden/db: rule proposals need a person (rules 11 and 19)', () => {
  it('D+90 legal handover: proposal → a person submits → pending → another person approves', async () => {
    const out = await inTenant(appPool, FX.tenantA, async (db) => {
      await grantMaker(db);
      const c = await company(db, 'Legal Golden d.o.o.');
      await invoice(db, c, 90);
      await runDailyWorkflows(db, jobAudit(db), { keyring });
      const proposal = await db.query<{ id: string; case_id: string | null; status: string }>(
        `SELECT id, case_id, status FROM decisions
         WHERE customer_id = $1 AND source = 'rule' AND decision_type = 'legal_handover'`,
        [c],
      );
      const d = proposal.rows[0];
      const attentionBefore = (await listAttention(ctxFor(db))).filter(
        (i) => i.kind === 'rule_proposal' && i.refId === d?.id,
      ).length;
      const { approvalId } = await submitRuleProposal(ctxFor(db), d?.id ?? '');
      const again = await submitRuleProposal(ctxFor(db), d?.id ?? '').catch((e: unknown) => e);
      const pending = (await listPendingApprovals(ctxFor(db, FX.userA2))).find(
        (p) => p.id === approvalId,
      );
      const self = await decideApproval(ctxFor(db), approvalId, { decision: 'approve' }).catch(
        (e: unknown) => e,
      );
      const decided = await decideApproval(ctxFor(db, FX.userA2), approvalId, {
        decision: 'approve',
      });
      const after = await db.query<{ status: string; approved_by: string | null }>(
        'SELECT status, approved_by FROM decisions WHERE id = $1',
        [d?.id],
      );
      const k = await db.query<{ stage_code: string }>(
        'SELECT stage_code FROM collection_cases WHERE id = $1',
        [d?.case_id],
      );
      const attentionAfter = (await listAttention(ctxFor(db))).filter(
        (i) => i.kind === 'rule_proposal' && i.refId === d?.id,
      ).length;
      return {
        before: d?.status,
        hasCase: Boolean(d?.case_id),
        attentionBefore,
        attentionAfter,
        again,
        pending: pending?.actionType,
        self,
        decided,
        after: after.rows[0],
        stage: k.rows[0]?.stage_code,
      };
    });
    expect(out.before).toBe('proposed');
    expect(out.hasCase).toBe(true);
    expect(out.attentionBefore).toBe(1);
    expect(out.attentionAfter).toBe(0);
    expect((out.again as { code?: string }).code).toBe('conflict');
    expect(out.pending).toBe('case.legal_handover');
    expect(out.self).toBeInstanceOf(PermissionDeniedError);
    expect(out.decided).toEqual({ status: 'approved' });
    expect(out.after).toEqual({ status: 'approved', approved_by: FX.userA2 });
    expect(out.stage).toBe('legal');
  });

  it('a natural person’s proposed decision is approved only by a human checker', async () => {
    const out = await inTenant(appPool, FX.tenantA, async (db) => {
      const person = await createConsumer(db, keyring, { displayName: 'Golden Fizicko' });
      await invoice(db, person.id, 60);
      await runDailyWorkflows(db, jobAudit(db), { keyring });
      const proposal = await db.query<{ id: string }>(
        `SELECT id FROM decisions WHERE customer_id = $1 AND source = 'rule'
           AND decision_type = 'pre_litigation_notice' AND status = 'proposed'`,
        [person.id],
      );
      const id = proposal.rows[0]?.id ?? '';
      // Nobody can approve it without a request; the request needs a person.
      await db.query('SAVEPOINT direct');
      const direct = await db
        .query(`UPDATE decisions SET status = 'approved', approved_at = now() WHERE id = $1`, [id])
        .then(() => 'OK')
        .catch((e: { code?: string }) => e.code);
      await db.query('ROLLBACK TO SAVEPOINT direct');
      const { approvalId } = await submitRuleProposal(ctxFor(db), id);
      const req = await db.query<{ action_type: string; payload: Record<string, unknown> }>(
        'SELECT action_type, payload FROM approval_requests WHERE id = $1',
        [approvalId],
      );
      const rejectNoNote = await decideApproval(ctxFor(db, FX.userA2), approvalId, {
        decision: 'reject',
      }).catch((e: unknown) => e);
      await decideApproval(ctxFor(db, FX.userA2), approvalId, { decision: 'approve' });
      const after = await db.query<{ status: string; approved_by: string | null }>(
        'SELECT status, approved_by FROM decisions WHERE id = $1',
        [id],
      );
      return { direct, req: req.rows[0], rejectNoNote, after: after.rows[0] };
    });
    expect(out.direct).toBe('23514');
    expect(out.req).toMatchObject({
      action_type: 'decision.approve',
      payload: { decision_type: 'pre_litigation_notice', natural_person: true },
    });
    expect((out.rejectNoNote as { code?: string }).code).toBe('invalid_request');
    expect(out.after).toEqual({ status: 'approved', approved_by: FX.userA2 });
  });
});

describe('golden/db: run the daily job now', () => {
  it('is audited, goes through the outbox and is idempotent', async () => {
    const out = await inTenant(appPool, FX.tenantA, async (db) => {
      const c = await company(db, 'Daily Golden d.o.o.');
      const inv = await invoice(db, c, 14);
      const { eventId } = await requestDailyRun(ctxFor(db));
      const ev = await db.query<{ event_type: string }>(
        'SELECT event_type FROM domain_events WHERE id = $1',
        [eventId],
      );
      const handler = EVENT_HANDLERS['tenant.daily_requested'];
      const job = { db, tenantId: FX.tenantA, jobId: randomUUID(), audit: jobAudit(db) };
      const event = {
        id: eventId,
        tenantId: FX.tenantA,
        eventType: 'tenant.daily_requested',
        aggregateType: 'tenants',
        aggregateId: FX.tenantA,
        payload: {},
      };
      await handler?.(job, event);
      const count = () =>
        db
          .query<{ n: number }>(
            `SELECT (SELECT count(*) FROM workflow_runs WHERE customer_id = $1)
                  + (SELECT count(*) FROM tasks WHERE customer_id = $1)
                  + (SELECT count(*) FROM collection_cases WHERE customer_id = $1) AS n`,
            [c],
          )
          .then((r) => Number(r.rows[0]?.n ?? 0));
      const first = await count();
      await handler?.(job, { ...event, id: randomUUID() });
      const second = await count();
      const audit = await db.query(
        `SELECT 1 FROM audit_log WHERE action = 'tenant.daily_requested' AND entity_id = $1`,
        [FX.tenantA],
      );
      return { type: ev.rows[0]?.event_type, first, second, audited: audit.rowCount, inv };
    });
    expect(out.type).toBe('tenant.daily_requested');
    expect(out.first).toBeGreaterThanOrEqual(3); // D+14: run + case + call task
    expect(out.second).toBe(out.first);
    expect(out.audited).toBeGreaterThanOrEqual(1);
  });
});
