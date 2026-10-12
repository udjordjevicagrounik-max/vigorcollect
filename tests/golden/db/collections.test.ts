import { randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeAudit } from '@/server/auth/audit';
import { PermissionDeniedError, type Scope } from '@/server/auth/permissions';
import { ConflictError, NotFoundError, type TenantContext } from '@/server/auth/with-tenant';
import {
  createActivity,
  createCase,
  createPromise,
  decideLegalHandover,
  getCase,
  recordPayment,
  requestLegalHandover,
  runDailyCollections,
  updateCase,
  updatePromise,
} from '@/server/collections/service';
import { parseMasterKeyring } from '@/server/crypto/keyring';
import { createConsumer } from '@/server/customers/repository';
import { customerActivities } from '@/server/receivables/service';
import { ensureFixtures, FX } from './fixtures';
import { appPool, closePools, inTenant, inTenantCommit, migratePool } from './helpers';

// Golden (never delete or skip) — task 2.4: cases only on the customer's own open invoices,
// legal stage only through an approved handover (rule 11, four eyes) and, for a natural
// person, a human decision (rule 19); manual payment allocated to the named invoice, then FIFO
// by due date; promise fulfilled by payment, broken / partial at D+1 in the company's zone by
// the daily job; activity notes encrypted; domain events for case / promise / payment.

const keyring = parseMasterKeyring(`1:${randomBytes(32).toString('base64')}`);
process.env.PII_MASTER_KEYS = `1:${randomBytes(32).toString('base64')}`;

beforeAll(async () => {
  await ensureFixtures();
  await inTenantCommit(migratePool, FX.tenantA, async (c) => {
    await c.query('SELECT provision_receivables_defaults()');
  });
});
afterAll(closePools);

function ctxFor(db: PoolClient, userId: string = FX.userA, scope: Scope = 'ORGANIZATION'): TenantContext {
  const requestId = randomUUID();
  return {
    db,
    tenantId: FX.tenantA,
    userId,
    authUserId: 'golden',
    requestId,
    requirePermission: async (key) => ({ key, scope }),
    requireAnyPermission: async (keys) => ({ key: keys[0] ?? '', scope }),
    audit: (entry) => writeAudit(db, { type: 'user', id: userId }, entry, requestId),
  };
}

async function customer(db: PoolClient, owner: string | null = null): Promise<string> {
  const le = await db.query<{ id: string }>(
    `SELECT find_or_create_legal_entity('XX', $1, 'Golden collections', 'UTC', NULL) AS id`,
    [`COLL-${randomUUID().slice(0, 12)}`],
  );
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO customers (tenant_id, legal_entity_id, display_name, owner_user_id)
     VALUES ($1, $2, 'Golden collections', $3) RETURNING id`,
    [FX.tenantA, le.rows[0]?.id, owner],
  );
  return rows[0]?.id ?? '';
}

async function invoice(db: PoolClient, customerId: string, dueOffsetDays: number, total: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO invoices (tenant_id, company_id, customer_id, source_id, external_id, number, issue_date,
                           due_date, currency, amount_total, amount_open)
     SELECT $1, $2, $3, s.id, $4, $4, (now() AT TIME ZONE 'UTC')::date - 60,
            (now() AT TIME ZONE 'UTC')::date + $5::int, 'EUR', $6, $6
     FROM data_sources s WHERE s.name = 'file-import' RETURNING id`,
    [FX.tenantA, FX.companyA, customerId, `C-${randomUUID().slice(0, 8)}`, dueOffsetDays, total],
  );
  return rows[0]?.id ?? '';
}

const open = (db: PoolClient, id: string) =>
  db.query<{ amount_open: string }>('SELECT amount_open FROM invoices WHERE id = $1', [id]).then((r) => r.rows[0]?.amount_open);
const events = (db: PoolClient, type: string) =>
  db.query('SELECT 1 FROM domain_events WHERE event_type = $1', [type]).then((r) => r.rowCount);
const today = `(now() AT TIME ZONE 'UTC')::date`;

describe('golden/db: collection cases', () => {
  it('a case takes only the customer’s own open invoices and emits case.opened', async () => {
    const out = await inTenant(appPool, FX.tenantA, async (db) => {
      const a = await customer(db);
      const b = await customer(db);
      const ia = await invoice(db, a, -10, '100.00');
      const ib = await invoice(db, b, -10, '100.00');
      const ctx = ctxFor(db);
      const foreign = await createCase(ctx, { customerId: a, invoiceIds: [ia, ib] }).catch((e: unknown) => e);
      const { id } = await createCase(ctx, { customerId: a, invoiceIds: [ia] });
      const detail = await getCase(ctx, id);
      return { foreign, detail, opened: await events(db, 'case.opened') };
    });
    expect(out.foreign).toBeInstanceOf(ConflictError);
    expect(out.detail).toMatchObject({ stage: 'new', status: 'open', invoices: [expect.objectContaining({ amountOpen: '100.00' })] });
    expect(out.detail.timeline.map((t) => t.type)).toContain('case.opened');
    expect(out.opened).toBe(1);
  });

  it('OWN cannot open a case or read a case of someone else’s customer (404)', async () => {
    const out = await inTenant(appPool, FX.tenantA, async (db) => {
      const theirs = await customer(db, FX.userA);
      const inv = await invoice(db, theirs, -1, '5.00');
      const { id } = await createCase(ctxFor(db), { customerId: theirs, invoiceIds: [inv] });
      const own = ctxFor(db, FX.userA2, 'OWN');
      return {
        create: await createCase(own, { customerId: theirs, invoiceIds: [inv] }).catch((e: unknown) => e),
        read: await getCase(own, id).catch((e: unknown) => e),
      };
    });
    expect(out.create).toBeInstanceOf(NotFoundError);
    expect(out.read).toBeInstanceOf(NotFoundError);
  });

  it('the legal stage is never set directly — only an approved handover by another person', async () => {
    const out = await inTenant(appPool, FX.tenantA, async (db) => {
      const c = await customer(db);
      const { id } = await createCase(ctxFor(db), { customerId: c, invoiceIds: [await invoice(db, c, -40, '9.00')] });
      const direct = await updateCase(ctxFor(db), id, { stageCode: 'legal' }).catch((e: unknown) => e);
      const { approvalId } = await requestLegalHandover(ctxFor(db), id, { reason: 'Bez odgovora 60 dana' });
      const self = await decideLegalHandover(ctxFor(db), approvalId, { decision: 'approve' }).catch((e: unknown) => e);
      const decided = await decideLegalHandover(ctxFor(db, FX.userA2), approvalId, { decision: 'approve' });
      const k = await db.query('SELECT stage_code, legal_approval_id FROM collection_cases WHERE id = $1', [id]);
      return { direct, self, decided, k: k.rows[0], approvalId };
    });
    expect(out.direct).toBeInstanceOf(ConflictError);
    expect(out.self).toBeInstanceOf(PermissionDeniedError);
    expect(out.decided).toEqual({ status: 'approved' });
    expect(out.k).toEqual({ stage_code: 'legal', legal_approval_id: out.approvalId });
  });

  it('a natural person’s handover is a human decision approved by someone else (rule 19)', async () => {
    const out = await inTenant(appPool, FX.tenantA, async (db) => {
      const person = await createConsumer(db, keyring, { displayName: 'Golden Person' });
      const { id } = await createCase(ctxFor(db), { customerId: person.id, invoiceIds: [await invoice(db, person.id, -50, '3.00')] });
      const { approvalId } = await requestLegalHandover(ctxFor(db), id, { reason: 'Opomena bez odgovora' });
      const proposed = await db.query('SELECT status, source, has_legal_effect FROM decisions WHERE approval_request_id = $1', [approvalId]);
      await decideLegalHandover(ctxFor(db, FX.userA2), approvalId, { decision: 'approve' });
      const approved = await db.query('SELECT status, approved_by FROM decisions WHERE approval_request_id = $1', [approvalId]);
      return { proposed: proposed.rows[0], approved: approved.rows[0] };
    });
    expect(out.proposed).toEqual({ status: 'proposed', source: 'human', has_legal_effect: true });
    expect(out.approved).toEqual({ status: 'approved', approved_by: FX.userA2 });
  });
});

describe('golden/db: payments and promises', () => {
  it('a manual payment goes to the named invoice first, then FIFO by due date; a covered promise is fulfilled', async () => {
    const out = await inTenant(appPool, FX.tenantA, async (db) => {
      const c = await customer(db);
      const older = await invoice(db, c, -30, '100.00');
      const newer = await invoice(db, c, -5, '100.00');
      const named = await invoice(db, c, 20, '50.00');
      const ctx = ctxFor(db);
      const { id: promiseId } = await createPromise(ctx, {
        customerId: c,
        amount: '180.00',
        currency: 'EUR',
        promisedOn: (await db.query<{ d: string }>(`SELECT (${today} + 3)::text AS d`)).rows[0]?.d ?? '',
      });
      const paidOn = (await db.query<{ d: string }>(`SELECT ${today}::text AS d`)).rows[0]?.d ?? '';
      const pay = await recordPayment(ctx, { customerId: c, amount: '200.00', currency: 'EUR', paidOn, invoiceId: named });
      const promise = await db.query('SELECT status, paid_amount FROM promises WHERE id = $1', [promiseId]);
      return {
        pay,
        opens: [await open(db, named), await open(db, older), await open(db, newer)],
        promise: promise.rows[0],
        promiseId,
        received: await events(db, 'payment.received'),
        fulfilledEvents: await events(db, 'promise.fulfilled'),
      };
    });
    expect(out.opens).toEqual(['0.00', '0.00', '50.00']);
    expect(out.pay).toMatchObject({ allocated: '200.00', unallocated: '0.00', fulfilled: [out.promiseId] });
    expect(out.promise).toEqual({ status: 'fulfilled', paid_amount: '200.00' });
    expect([out.received, out.fulfilledEvents]).toEqual([1, 1]);
  });

  it('an overpayment stays unallocated; a future payment date is refused', async () => {
    const out = await inTenant(appPool, FX.tenantA, async (db) => {
      const c = await customer(db);
      await invoice(db, c, -3, '10.00');
      const d = (await db.query<{ t: string; f: string }>(`SELECT ${today}::text AS t, (${today} + 1)::text AS f`)).rows[0];
      const ctx = ctxFor(db);
      return {
        over: await recordPayment(ctx, { customerId: c, amount: '15.50', currency: 'EUR', paidOn: d?.t ?? '' }),
        future: await recordPayment(ctx, { customerId: c, amount: '1.00', currency: 'EUR', paidOn: d?.f ?? '' }).catch((e: unknown) => e),
      };
    });
    expect(out.over).toMatchObject({ allocated: '10.00', unallocated: '5.50' });
    expect(out.future).toBeInstanceOf(ConflictError);
  });

  it('a promise is edited or cancelled only while pending; never dated in the past', async () => {
    const out = await inTenant(appPool, FX.tenantA, async (db) => {
      const c = await customer(db);
      const d = (await db.query<{ t: string; y: string }>(`SELECT ${today}::text AS t, (${today} - 1)::text AS y`)).rows[0];
      const ctx = ctxFor(db);
      const past = await createPromise(ctx, { customerId: c, amount: '1.00', currency: 'EUR', promisedOn: d?.y ?? '' }).catch((e: unknown) => e);
      const { id } = await createPromise(ctx, { customerId: c, amount: '1.00', currency: 'EUR', promisedOn: d?.t ?? '' });
      await updatePromise(ctx, id, { amount: '2.00' });
      await updatePromise(ctx, id, { cancel: true });
      const again = await updatePromise(ctx, id, { amount: '3.00' }).catch((e: unknown) => e);
      const row = await db.query('SELECT status, amount FROM promises WHERE id = $1', [id]);
      return { past, again, row: row.rows[0], cancelled: await events(db, 'promise.cancelled') };
    });
    expect(out.past).toBeInstanceOf(ConflictError);
    expect(out.again).toBeInstanceOf(ConflictError);
    expect(out.row).toEqual({ status: 'cancelled', amount: '2.00' });
    expect(out.cancelled).toBe(1);
  });

  it('the daily job: broken / partial at D+1 (company zone), invoice.overdue once', async () => {
    const out = await inTenant(appPool, FX.tenantA, async (db) => {
      const c = await customer(db);
      await invoice(db, c, -1, '70.00'); // due yesterday → overdue today
      const insert = (amount: string) =>
        db
          .query<{ id: string }>(
            `INSERT INTO promises (tenant_id, customer_id, company_id, amount, currency, promised_on, made_on)
             VALUES ($1, $2, $3, $4, 'EUR', ${today} - 1, ${today} - 5) RETURNING id`,
            [FX.tenantA, c, FX.companyA, amount],
          )
          .then((r) => r.rows[0]?.id ?? '');
      const big = await insert('500.00');
      const small = await insert('40.00');
      // 30 paid three days ago (inside both windows): partial for 40, not enough for 500 either.
      await db.query(
        `INSERT INTO payments (tenant_id, customer_id, source_id, paid_on, amount, currency)
         SELECT $1, $2, s.id, ${today} - 3, '30.00', 'EUR' FROM data_sources s WHERE s.name = 'file-import'`,
        [FX.tenantA, c],
      );
      const audit = (entry: Parameters<TenantContext['audit']>[0]) => writeAudit(db, { type: 'job', id: null }, entry, null);
      const first = await runDailyCollections(db, audit);
      const second = await runDailyCollections(db, audit);
      const st = await db.query<{ id: string; status: string; paid_amount: string }>(
        'SELECT id, status, paid_amount FROM promises WHERE id = ANY($1)',
        [[big, small]],
      );
      return {
        first,
        second,
        statuses: Object.fromEntries(st.rows.map((r) => [r.id === big ? 'big' : 'small', [r.status, r.paid_amount]])),
        partialEvents: await events(db, 'promise.partial'),
      };
    });
    expect(out.first).toMatchObject({ partial: 2, broken: 0, overdue: 1 });
    expect(out.second).toMatchObject({ partial: 0, broken: 0, fulfilled: 0, overdue: 0 });
    expect(out.statuses).toEqual({ big: ['partial', '30.00'], small: ['partial', '30.00'] });
    expect(out.partialEvents).toBe(2);
  });

  it('a promise without any payment by D+1 is broken and emits promise.broken', async () => {
    const out = await inTenant(appPool, FX.tenantA, async (db) => {
      const c = await customer(db);
      await db.query(
        `INSERT INTO promises (tenant_id, customer_id, company_id, amount, currency, promised_on, made_on)
         VALUES ($1, $2, $3, '10.00', 'EUR', ${today} - 1, ${today} - 2)`,
        [FX.tenantA, c, FX.companyA],
      );
      const result = await runDailyCollections(db, (e) => writeAudit(db, { type: 'job', id: null }, e, null));
      return { result, events: await events(db, 'promise.broken') };
    });
    expect(out.result.broken).toBe(1);
    expect(out.events).toBe(1);
  });
});

describe('golden/db: activities', () => {
  it('a note is stored encrypted and read back only through the service', async () => {
    const out = await inTenant(appPool, FX.tenantA, async (db) => {
      const c = await customer(db);
      const ctx = ctxFor(db);
      const { id } = await createActivity(
        ctx,
        { customerId: c, kind: 'call', outcomeCode: 'promise_given', nextActionCode: 'check_payment', nextActionOn: '2030-01-01', note: 'Direktor obećao uplatu u petak' },
        keyring,
      );
      const raw = await db.query<{ note_enc: Buffer }>('SELECT note_enc FROM activities WHERE id = $1', [id]);
      const list = await customerActivities(ctx, c, keyring);
      return { raw: raw.rows[0]?.note_enc.toString('latin1') ?? '', list, logged: await events(db, 'activity.logged') };
    });
    expect(out.raw).not.toContain('obećao');
    expect(out.list[0]).toMatchObject({ kind: 'call', outcome: 'promise_given', note: 'Direktor obećao uplatu u petak' });
    expect(out.logged).toBe(1);
  });

  it('an unknown outcome code fails the code list FK', async () => {
    const state = await inTenant(appPool, FX.tenantA, async (db) => {
      const c = await customer(db);
      return createActivity(ctxFor(db), { customerId: c, kind: 'note', outcomeCode: 'nope' }, keyring).catch(
        (e: unknown) => (e as { code?: string }).code,
      );
    });
    expect(state).toBe('23503');
  });
});
