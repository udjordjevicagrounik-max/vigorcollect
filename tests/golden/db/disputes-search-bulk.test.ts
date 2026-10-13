import { randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeAudit, type AuditEntry } from '@/server/auth/audit';
import type { Scope } from '@/server/auth/permissions';
import { ConflictError, NotFoundError, type TenantContext } from '@/server/auth/with-tenant';
import { previewBulk, runBulk, startBulk } from '@/server/bulk/service';
import { parseMasterKeyring } from '@/server/crypto/keyring';
import { createContact } from '@/server/customers/repository';
import { listDisputes, openDispute, updateDispute } from '@/server/disputes/service';
import { listReceivableCustomers } from '@/server/receivables/service';
import { globalSearch } from '@/server/search/service';
import { runDailyWorkflows } from '@/server/workflows/engine';
import { ensureFixtures, FX } from './fixtures';
import { appPool, closePools, inTenant, inTenantCommit, migratePool } from './helpers';

// Golden (never delete or skip) — task 5.1:
//   - a disputed invoice stays in aging, marked; the rule engine sends no reminder for it
//     (has_open_dispute); the dispute's status machine ends in a final state; the resolution
//     note is encrypted; another member's customer is 404;
//   - global search: tenant A never finds B; OWN finds only own customers; LIKE wildcards in the
//     query are literal; contacts only by exact e-mail (blind index);
//   - bulk: preview counts only what is in scope; legal-effect templates are never bulk (rule
//     19); the tenant limit holds; the worker runs every item as the requester — one audit entry
//     per item plus the run; a disputed customer gets no bulk reminder.

const keyring = parseMasterKeyring(`1:${randomBytes(32).toString('base64')}`);
process.env.PII_MASTER_KEYS = `1:${randomBytes(32).toString('base64')}`;
const EMAIL = 'golden.s5@example.test';

beforeAll(async () => {
  await ensureFixtures();
  for (const t of [FX.tenantA, FX.tenantB]) {
    await inTenantCommit(migratePool, t, async (c) => {
      await c.query('SELECT provision_receivables_defaults()');
    });
  }
});
afterAll(closePools);

function ctxFor(
  db: PoolClient,
  userId: string = FX.userA,
  scope: Scope = 'ORGANIZATION',
  tenantId: string = FX.tenantA,
): TenantContext {
  const requestId = randomUUID();
  return {
    db,
    tenantId,
    userId,
    authUserId: 'golden',
    requestId,
    requirePermission: async (key) => ({ key, scope }),
    requireAnyPermission: async (keys) => ({ key: keys[0] ?? '', scope }),
    audit: (entry) => writeAudit(db, { type: 'user', id: userId }, entry, requestId),
  };
}

const jobAudit = (db: PoolClient) => (entry: AuditEntry) =>
  writeAudit(db, { type: 'job', id: null }, entry, null);

async function company(
  db: PoolClient,
  name: string,
  owner: string | null = FX.userA,
  tenantId: string = FX.tenantA,
): Promise<string> {
  const le = await db.query<{ id: string }>(
    `SELECT find_or_create_legal_entity('XX', $1, $2, 'UTC', NULL) AS id`,
    [`S5-${randomUUID().slice(0, 12)}`, name],
  );
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO customers (tenant_id, legal_entity_id, display_name, owner_user_id)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [tenantId, le.rows[0]?.id, name, owner],
  );
  return rows[0]?.id ?? '';
}

async function invoice(
  db: PoolClient,
  customerId: string,
  daysAgo: number,
  number = `S5-${randomUUID().slice(0, 8)}`,
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO invoices (tenant_id, company_id, customer_id, source_id, external_id, number, issue_date,
                           due_date, currency, amount_total, amount_open)
     SELECT $1, $2, $3, s.id, $4, $4, (now() AT TIME ZONE 'UTC')::date - $5::int - 30,
            (now() AT TIME ZONE 'UTC')::date - $5::int, 'EUR', '250.00', '250.00'
     FROM data_sources s WHERE s.name = 'file-import' RETURNING id`,
    [FX.tenantA, FX.companyA, customerId, number, daysAgo],
  );
  return rows[0]?.id ?? '';
}

/** userA really holds the bulk permissions inside the (rolled back) test — the worker checks. */
async function grantBulk(db: PoolClient): Promise<void> {
  await db.query(
    `INSERT INTO user_roles (tenant_id, user_id, role_id, scope) VALUES ($1, $2, $3, 'ORGANIZATION')
     ON CONFLICT DO NOTHING`,
    [FX.tenantA, FX.userA, FX.roleA],
  );
  await db.query(
    `INSERT INTO role_permissions (tenant_id, role_id, permission_id)
     SELECT $1, $2, p.id FROM permissions p
     WHERE p.key IN ('customer.read', 'customer.assign', 'customer.update', 'activity.create', 'case.create')
     ON CONFLICT DO NOTHING`,
    [FX.tenantA, FX.roleA],
  );
}

const job = (db: PoolClient) => ({
  db,
  tenantId: FX.tenantA,
  jobId: randomUUID(),
  audit: jobAudit(db),
});

describe('golden/db: disputes (5.1)', () => {
  it('a disputed invoice stays in aging, marked; the customer list shows the disputed amount', async () => {
    const out = await inTenant(appPool, FX.tenantA, async (db) => {
      const c = await company(db, 'Spor Golden d.o.o.');
      const disputed = await invoice(db, c, 10);
      await invoice(db, c, 5);
      await openDispute(ctxFor(db), {
        customerId: c,
        invoiceIds: [disputed],
        reasonCode: 'pricing',
      });
      const pos = await db.query<{
        invoice_id: string;
        is_disputed: boolean;
        aging_bucket: string | null;
      }>(
        'SELECT invoice_id, is_disputed, aging_bucket FROM invoice_positions WHERE customer_id = $1 ORDER BY invoice_id',
        [c],
      );
      const [row] = await listReceivableCustomers(ctxFor(db), { q: 'Spor Golden' });
      return { pos: pos.rows, disputed, row };
    });
    expect(out.pos).toHaveLength(2);
    for (const p of out.pos) {
      expect(p.aging_bucket).not.toBeNull();
      expect(p.is_disputed).toBe(p.invoice_id === out.disputed);
    }
    expect(out.row).toMatchObject({ overdue: '500.00', disputed: '250.00' });
  });

  it('status machine: open → in_review → resolved is final; the note is encrypted', async () => {
    const note = 'Kupac je dostavio dokaz o reklamaciji 4711';
    const out = await inTenant(appPool, FX.tenantA, async (db) => {
      const c = await company(db, 'Status Golden d.o.o.');
      const inv = await invoice(db, c, 3);
      const ctx = ctxFor(db);
      const { id } = await openDispute(ctx, {
        customerId: c,
        invoiceIds: [inv],
        reasonCode: 'quality',
      });
      await updateDispute(ctx, id, { status: 'in_review' }, keyring);
      await updateDispute(ctx, id, { status: 'resolved_rejected', resolutionNote: note }, keyring);
      const reopen = await updateDispute(ctx, id, { status: 'open' }, keyring).catch(
        (e: unknown) => e,
      );
      const raw = await db.query<{ raw: string }>(
        `SELECT encode(resolution_note_enc, 'escape') AS raw FROM disputes WHERE id = $1`,
        [id],
      );
      const marked = await db.query<{ is_disputed: boolean }>(
        'SELECT is_disputed FROM invoice_positions WHERE invoice_id = $1',
        [inv],
      );
      const active = await listDisputes(ctx, { customerId: c, status: 'active' });
      return { reopen, raw: raw.rows[0]?.raw ?? '', marked: marked.rows[0]?.is_disputed, active };
    });
    expect(out.reopen).toBeInstanceOf(ConflictError);
    expect(out.raw).not.toContain('4711');
    expect(out.marked).toBe(false);
    expect(out.active).toEqual([]);
  });

  it('OWN cannot open a dispute on someone else’s customer (404)', async () => {
    const out = await inTenant(appPool, FX.tenantA, async (db) => {
      const c = await company(db, 'Tudji Golden d.o.o.', FX.userA);
      const inv = await invoice(db, c, 3);
      return openDispute(ctxFor(db, FX.userA2, 'OWN'), {
        customerId: c,
        invoiceIds: [inv],
        reasonCode: 'pricing',
      }).catch((e: unknown) => e);
    });
    expect(out).toBeInstanceOf(NotFoundError);
  });

  it('the rule engine sends no reminder for a disputed invoice (has_open_dispute)', async () => {
    const out = await inTenant(appPool, FX.tenantA, async (db) => {
      const c = await company(db, 'Podsetnik Spor d.o.o.');
      await createContact(db, keyring, { customerId: c, name: 'K', email: EMAIL, isPrimary: true });
      const inv = await invoice(db, c, 1);
      await openDispute(ctxFor(db), { customerId: c, invoiceIds: [inv], reasonCode: 'delivery' });
      await runDailyWorkflows(db, jobAudit(db), { keyring });
      const mail = await db.query('SELECT 1 FROM mail_outbox WHERE customer_id = $1', [c]);
      const a = await db.query<{ status: string; result: { reason?: string } }>(
        `SELECT a.status, a.result FROM workflow_run_actions a JOIN workflow_runs r ON r.id = a.run_id
         WHERE r.entity_id = $1 AND a.action_type = 'queue_email'`,
        [inv],
      );
      return { mail: mail.rowCount, actions: a.rows };
    });
    expect(out.mail).toBe(0);
    expect(out.actions).toEqual([
      expect.objectContaining({
        status: 'skipped',
        result: expect.objectContaining({ reason: 'disputed' }),
      }),
    ]);
  });
});

describe('golden/db: global search (5.1)', () => {
  it('tenant A never finds a customer of tenant B; B finds its own', async () => {
    const a = await inTenant(appPool, FX.tenantA, (db) =>
      globalSearch(ctxFor(db), { q: 'golden-b' }, keyring),
    );
    const b = await inTenant(appPool, FX.tenantB, (db) =>
      globalSearch(ctxFor(db, FX.userB, 'ORGANIZATION', FX.tenantB), { q: 'golden-b' }, keyring),
    );
    expect(a).toEqual([]);
    expect(b.map((h) => h.id)).toContain(FX.customerB);
  });

  it('OWN finds only own customers; % and _ are literal; at most 20 hits', async () => {
    const out = await inTenant(appPool, FX.tenantA, async (db) => {
      await company(db, 'Pretraga Moj d.o.o.', FX.userA2);
      await company(db, 'Pretraga Tudji d.o.o.', FX.userA);
      for (let i = 0; i < 25; i += 1) await company(db, `Masovno ${i} d.o.o.`);
      const own = await globalSearch(ctxFor(db, FX.userA2, 'OWN'), { q: 'Pretraga' }, keyring);
      const wildcard = await globalSearch(ctxFor(db), { q: '%%' }, keyring);
      const underscore = await globalSearch(ctxFor(db), { q: '__' }, keyring);
      const many = await globalSearch(ctxFor(db), { q: 'Masovno' }, keyring);
      return { own: own.map((h) => h.customerName), wildcard, underscore, many: many.length };
    });
    expect(out.own).toEqual(['Pretraga Moj d.o.o.']);
    expect(out.wildcard).toEqual([]);
    expect(out.underscore).toEqual([]);
    expect(out.many).toBe(20);
  });

  it('finds an invoice by number and a contact only by the exact e-mail', async () => {
    const out = await inTenant(appPool, FX.tenantA, async (db) => {
      const c = await company(db, 'Kontakt Pretraga d.o.o.');
      await invoice(db, c, 1, 'S5-FAKT-0042');
      await createContact(db, keyring, { customerId: c, name: 'K', email: EMAIL, isPrimary: true });
      const ctx = ctxFor(db);
      return {
        c,
        inv: await globalSearch(ctx, { q: 's5-fakt' }, keyring),
        exact: await globalSearch(ctx, { q: EMAIL }, keyring),
        partial: await globalSearch(ctx, { q: 'golden.s5@' }, keyring),
      };
    });
    expect(out.inv).toEqual([expect.objectContaining({ kind: 'invoice', detail: 'S5-FAKT-0042' })]);
    expect(out.exact).toEqual([expect.objectContaining({ kind: 'contact', customerId: out.c })]);
    expect(out.partial.filter((h) => h.kind === 'contact')).toEqual([]);
  });
});

describe('golden/db: bulk actions (5.1)', () => {
  it('preview counts only the selection in scope; another tenant’s id is never counted', async () => {
    const out = await inTenant(appPool, FX.tenantA, async (db) => {
      const mine = await company(db, 'Bulk Moj d.o.o.', FX.userA2);
      const theirs = await company(db, 'Bulk Tudji d.o.o.', FX.userA);
      return previewBulk(ctxFor(db, FX.userA2, 'OWN'), {
        entity: 'customers',
        ids: [mine, theirs, FX.customerB],
        bulk: { action: 'assign_team', params: { teamId: randomUUID() } },
      }).catch((e: unknown) => e);
    });
    // The team does not exist → invalid parameters, after scope (never leaks the count).
    expect(out).toBeInstanceOf(ConflictError);
    const preview = await inTenant(appPool, FX.tenantA, async (db) => {
      const mine = await company(db, 'Bulk Moj d.o.o.', FX.userA2);
      const theirs = await company(db, 'Bulk Tudji d.o.o.', FX.userA);
      return previewBulk(ctxFor(db, FX.userA2, 'OWN'), {
        entity: 'customers',
        ids: [mine, theirs, FX.customerB],
        bulk: { action: 'change_policy', params: { policyCode: 'friendly' } },
      });
    });
    expect(preview).toMatchObject({ count: 1, skipped: 2, limit: 500 });
    expect(preview.sample.map((s) => s.label)).toEqual(['Bulk Moj d.o.o.']);
  });

  it('a template with legal effect is never bulk (rule 19); the tenant limit holds', async () => {
    const out = await inTenant(appPool, FX.tenantA, async (db) => {
      const a = await company(db, 'Limit A d.o.o.');
      const b = await company(db, 'Limit B d.o.o.');
      const ctx = ctxFor(db);
      const legal = await startBulk(ctx, {
        entity: 'customers',
        ids: [a],
        bulk: { action: 'send_reminder', params: { templateKey: 'pre_litigation_notice' } },
      }).catch((e: unknown) => e);
      await db.query('UPDATE tenant_settings SET bulk_max_items = 1');
      const limit = await startBulk(ctx, {
        entity: 'customers',
        ids: [a, b],
        bulk: { action: 'change_policy', params: { policyCode: 'friendly' } },
      }).catch((e: unknown) => e);
      return { legal, limit };
    });
    expect(out.legal).toMatchObject({ code: 'not_bulk' });
    expect(out.limit).toMatchObject({ code: 'limit_exceeded' });
  });

  it('the worker runs each item as the requester: audit per item + the run; report per item', async () => {
    const out = await inTenant(appPool, FX.tenantA, async (db) => {
      await grantBulk(db);
      const a = await company(db, 'Owner A d.o.o.', null);
      const b = await company(db, 'Owner B d.o.o.', FX.userA2);
      const { id } = await startBulk(ctxFor(db), {
        entity: 'customers',
        ids: [a, b],
        bulk: { action: 'assign_owner', params: { userId: FX.userA2 } },
      });
      const event = await db.query(
        'SELECT 1 FROM domain_events WHERE event_type = $1 AND aggregate_id = $2',
        ['bulk.requested', id],
      );
      const result = await runBulk(job(db), id, { keyring });
      const again = await runBulk(job(db), id, { keyring });
      const owners = await db.query<{ id: string; owner_user_id: string }>(
        'SELECT id, owner_user_id FROM customers WHERE id = ANY($1::uuid[])',
        [[a, b]],
      );
      const audits = await db.query<{ action: string; n: number }>(
        `SELECT action, count(*)::int AS n FROM audit_log
         WHERE action IN ('customer.assign_owner', 'bulk_run.requested', 'bulk_run.completed')
           AND (entity_id = ANY($1::uuid[]) OR entity_id = $2) GROUP BY action ORDER BY action`,
        [[a, b], id],
      );
      const items = await db.query<{
        entity_id: string;
        status: string;
        error_code: string | null;
      }>('SELECT entity_id, status, error_code FROM bulk_run_items WHERE run_id = $1', [id]);
      const run = await db.query<{ status: string; ok_count: number }>(
        'SELECT status, ok_count FROM bulk_runs WHERE id = $1',
        [id],
      );
      return {
        a,
        b,
        event: event.rowCount,
        result,
        again,
        owners: owners.rows,
        audits: audits.rows,
        items: items.rows,
        run: run.rows[0],
      };
    });
    expect(out.event).toBe(1);
    expect(out.result).toEqual({ ok: 1, failed: 0, skipped: 1 });
    expect(out.again).toBeNull();
    expect(out.owners.every((o) => o.owner_user_id === FX.userA2)).toBe(true);
    expect(out.audits).toEqual([
      { action: 'bulk_run.completed', n: 1 },
      { action: 'bulk_run.requested', n: 1 },
      { action: 'customer.assign_owner', n: 1 },
    ]);
    expect(out.items).toEqual(
      expect.arrayContaining([
        { entity_id: out.a, status: 'ok', error_code: null },
        { entity_id: out.b, status: 'skipped', error_code: 'unchanged' },
      ]),
    );
    expect(out.run).toEqual({ status: 'completed', ok_count: 1 });
  });

  it('a bulk reminder skips a customer whose overdue invoices are all disputed', async () => {
    const out = await inTenant(appPool, FX.tenantA, async (db) => {
      await grantBulk(db);
      const disputed = await company(db, 'Bulk Spor d.o.o.');
      const clean = await company(db, 'Bulk Cist d.o.o.');
      for (const c of [disputed, clean])
        await createContact(db, keyring, {
          customerId: c,
          name: 'K',
          email: EMAIL,
          isPrimary: true,
        });
      const inv = await invoice(db, disputed, 5);
      await invoice(db, clean, 5);
      await openDispute(ctxFor(db), {
        customerId: disputed,
        invoiceIds: [inv],
        reasonCode: 'pricing',
      });
      const { id } = await startBulk(ctxFor(db), {
        entity: 'customers',
        ids: [disputed, clean],
        bulk: { action: 'send_reminder', params: { templateKey: 'reminder_overdue' } },
      });
      await runBulk(job(db), id, { keyring });
      const mail = await db.query<{ customer_id: string }>(
        'SELECT customer_id FROM mail_outbox WHERE customer_id = ANY($1::uuid[])',
        [[disputed, clean]],
      );
      const items = await db.query<{
        entity_id: string;
        status: string;
        error_code: string | null;
      }>('SELECT entity_id, status, error_code FROM bulk_run_items WHERE run_id = $1', [id]);
      return { disputed, clean, mail: mail.rows.map((r) => r.customer_id), items: items.rows };
    });
    expect(out.mail).toEqual([out.clean]);
    expect(out.items).toEqual(
      expect.arrayContaining([
        { entity_id: out.clean, status: 'ok', error_code: null },
        { entity_id: out.disputed, status: 'skipped', error_code: 'disputed_or_not_overdue' },
      ]),
    );
  });
});
