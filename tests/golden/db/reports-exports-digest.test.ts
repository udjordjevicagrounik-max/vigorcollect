import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeAudit, type AuditEntry } from '@/server/auth/audit';
import { PermissionDeniedError, type Scope } from '@/server/auth/permissions';
import { ConflictError, NotFoundError, type TenantContext } from '@/server/auth/with-tenant';
import { runBulk, startBulk } from '@/server/bulk/service';
import { recordPayment } from '@/server/collections/service';
import { parseMasterKeyring } from '@/server/crypto/keyring';
import { createContact } from '@/server/customers/repository';
import { openDispute } from '@/server/disputes/service';
import {
  downloadExportFile,
  exportSelection,
  requestExport,
  runExportFile,
} from '@/server/exports/tables';
import { readOutbox } from '@/server/mail/adapter';
import { runTenantDigests, savePreferences } from '@/server/notifications/digest';
import { onboardingState } from '@/server/onboarding/service';
import { runReport } from '@/server/reports/service';
import {
  saveAgingBounds,
  saveThresholds,
  getThresholds,
  upsertCode,
} from '@/server/settings/configuration';
import { ensureFixtures, FX } from './fixtures';
import { appPool, closePools, inTenant, inTenantCommit, migratePool } from './helpers';

// Golden (never delete or skip) — task 5.2:
//   - exportService: a small export returns the file and writes export_log (filters, rows, sha256);
//     a large one is queued, built by the worker AS THE REQUESTER, downloaded only by them
//     (export_log again); without *.export → 403; OWN scope exports only own customers;
//   - reports: aging by customer = invoice positions; collected counts payments only, in scope;
//   - settings: aging bounds stay contiguous; a code is never deleted, the default policy cannot
//     be deactivated; every change → audit + domain event;
//   - digest: 07:00 in the member's zone, once per local date, through the sink; nothing to
//     report → no mail.

const keyring = parseMasterKeyring(`1:${randomBytes(32).toString('base64')}`);
process.env.PII_MASTER_KEYS = `1:${randomBytes(32).toString('base64')}`;
process.env.DOCUMENTS_DIR = mkdtempSync(join(tmpdir(), 'golden-exports-'));

beforeAll(async () => {
  await ensureFixtures();
  await inTenantCommit(migratePool, FX.tenantA, async (c) => {
    await c.query('SELECT provision_receivables_defaults()');
  });
});
afterAll(closePools);

function ctxFor(
  db: PoolClient,
  userId: string = FX.userA,
  scope: Scope = 'ORGANIZATION',
  deny: string[] = [],
): TenantContext {
  const requestId = randomUUID();
  const grant = async (key: string) => {
    if (deny.includes(key)) throw new PermissionDeniedError();
    return { key, scope };
  };
  return {
    db,
    tenantId: FX.tenantA,
    userId,
    authUserId: 'golden',
    requestId,
    requirePermission: grant,
    requireAnyPermission: async (keys) => grant(keys[0] ?? ''),
    audit: (entry) => writeAudit(db, { type: 'user', id: userId }, entry, requestId),
  };
}

const job = (db: PoolClient) => ({
  db,
  tenantId: FX.tenantA,
  jobId: randomUUID(),
  audit: (entry: AuditEntry) => writeAudit(db, { type: 'job', id: null }, entry, null),
});

async function company(
  db: PoolClient,
  name: string,
  owner: string | null = FX.userA,
): Promise<string> {
  const le = await db.query<{ id: string }>(
    `SELECT find_or_create_legal_entity('XX', $1, $2, 'UTC', NULL) AS id`,
    [`R5-${randomUUID().slice(0, 12)}`, name],
  );
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO customers (tenant_id, legal_entity_id, display_name, owner_user_id)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [FX.tenantA, le.rows[0]?.id, name, owner],
  );
  return rows[0]?.id ?? '';
}

async function invoice(
  db: PoolClient,
  customerId: string,
  daysAgo: number,
  total = '100.00',
): Promise<string> {
  const number = `R5-${randomUUID().slice(0, 8)}`;
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO invoices (tenant_id, company_id, customer_id, source_id, external_id, number, issue_date,
                           due_date, currency, amount_total, amount_open)
     SELECT $1, $2, $3, s.id, $4, $4, (now() AT TIME ZONE 'UTC')::date - $5::int - 30,
            (now() AT TIME ZONE 'UTC')::date - $5::int, 'EUR', $6, $6
     FROM data_sources s WHERE s.name = 'file-import' RETURNING id`,
    [FX.tenantA, FX.companyA, customerId, number, daysAgo, total],
  );
  return rows[0]?.id ?? '';
}

/** userA really holds the export permissions in the (rolled back) test — the worker checks. */
async function grant(db: PoolClient, keys: string[]): Promise<void> {
  await db.query(
    `INSERT INTO user_roles (tenant_id, user_id, role_id, scope) VALUES ($1, $2, $3, 'ORGANIZATION')
     ON CONFLICT DO NOTHING`,
    [FX.tenantA, FX.userA, FX.roleA],
  );
  await db.query(
    `INSERT INTO role_permissions (tenant_id, role_id, permission_id)
     SELECT $1, $2, p.id FROM permissions p WHERE p.key = ANY($3::text[]) ON CONFLICT DO NOTHING`,
    [FX.tenantA, FX.roleA, keys],
  );
}

describe('golden/db: exportService (5.2)', () => {
  it('a small export returns the file and writes export_log; OWN exports only own customers', async () => {
    const out = await inTenant(appPool, FX.tenantA, async (db) => {
      await company(db, 'Izvoz Moj d.o.o.', FX.userA2);
      await company(db, 'Izvoz Tudji d.o.o.', FX.userA);
      const res = await requestExport(ctxFor(db, FX.userA2, 'OWN'), {
        type: 'customers',
        format: 'csv',
        filters: { q: 'Izvoz' },
      });
      const log = await db.query<{
        export_type: string;
        row_count: number;
        filters: unknown;
        sha: Buffer;
      }>(
        `SELECT export_type, row_count, filters, file_sha256 AS sha FROM export_log
         WHERE actor_id = $1 ORDER BY occurred_at DESC LIMIT 1`,
        [FX.userA2],
      );
      return { res, log: log.rows[0] };
    });
    expect(out.res.kind).toBe('file');
    if (out.res.kind !== 'file') return;
    const csv = out.res.content.toString('utf8');
    expect(csv).toContain('Izvoz Moj d.o.o.');
    expect(csv).not.toContain('Izvoz Tudji d.o.o.');
    expect(out.log).toMatchObject({
      export_type: 'export.customers',
      row_count: 1,
      filters: { q: 'Izvoz' },
    });
    expect(out.log?.sha.equals(createHash('sha256').update(out.res.content).digest())).toBe(true);
  });

  it('without customer.export → 403, nothing logged', async () => {
    const out = await inTenant(appPool, FX.tenantA, async (db) => {
      const before = await db.query('SELECT 1 FROM export_log');
      const err = await requestExport(ctxFor(db, FX.userA, 'ORGANIZATION', ['customer.export']), {
        type: 'customers',
      }).catch((e: unknown) => e);
      const after = await db.query('SELECT 1 FROM export_log');
      return { err, added: (after.rowCount ?? 0) - (before.rowCount ?? 0) };
    });
    expect(out.err).toBeInstanceOf(PermissionDeniedError);
    expect(out.added).toBe(0);
  });

  it('a large export is queued, built by the worker as the requester, downloaded only by them', async () => {
    const out = await inTenant(appPool, FX.tenantA, async (db) => {
      await grant(db, ['customer.read', 'invoice.read', 'invoice.export', 'export.read']);
      const c = await company(db, 'Veliki Izvoz d.o.o.');
      await invoice(db, c, 3, '10.50');
      await invoice(db, c, 4, '20.25');
      const queued = await requestExport(
        ctxFor(db),
        { type: 'invoices', format: 'xlsx', filters: { q: 'Veliki Izvoz' } },
        { syncRows: 1 },
      );
      if (queued.kind !== 'queued') throw new Error('expected queued');
      const event = await db.query(
        'SELECT 1 FROM domain_events WHERE event_type = $1 AND aggregate_id = $2',
        ['export.requested', queued.id],
      );
      const built = await runExportFile(job(db), queued.id, keyring);
      const other = await downloadExportFile(ctxFor(db, FX.userA2), queued.id, keyring).catch(
        (e: unknown) => e,
      );
      const file = await downloadExportFile(ctxFor(db), queued.id, keyring);
      const log = await db.query<{ row_count: number }>(
        `SELECT row_count FROM export_log WHERE filters->>'export_file_id' = $1`,
        [queued.id],
      );
      return { event: event.rowCount, built, other, file, log: log.rows };
    });
    expect(out.event).toBe(1);
    expect(out.built).toBe('ready');
    expect(out.other).toBeInstanceOf(NotFoundError);
    expect(out.file.filename.endsWith('.xlsx')).toBe(true);
    expect(out.file.content.readUInt32LE(0)).toBe(0x04034b50);
    expect(out.log).toEqual([{ row_count: 2 }]);
  });
});

describe('golden/db: bulk export (5.1 → 5.2)', () => {
  it('a bulk export of the selection becomes a ready export file of the requester', async () => {
    const out = await inTenant(appPool, FX.tenantA, async (db) => {
      await grant(db, ['customer.read', 'customer.export', 'export.read']);
      const a = await company(db, 'Bulk Izvoz A d.o.o.');
      const b = await company(db, 'Bulk Izvoz B d.o.o.');
      await company(db, 'Bulk Izvoz Nije Izabran d.o.o.');
      const { id } = await startBulk(ctxFor(db), {
        entity: 'customers',
        ids: [a, b],
        bulk: { action: 'export', params: { format: 'csv' } },
      });
      const result = await runBulk(job(db), id, {
        keyring,
        exportHook: (c, run) => exportSelection(c, run, keyring),
      });
      const ref = await db.query<{ result_ref: string }>(
        'SELECT result_ref FROM bulk_runs WHERE id = $1',
        [id],
      );
      const fileId = ref.rows[0]?.result_ref.slice('export:'.length) ?? '';
      const file = await downloadExportFile(ctxFor(db), fileId, keyring);
      return { result, csv: file.content.toString('utf8') };
    });
    expect(out.result).toEqual({ ok: 2, failed: 0, skipped: 0 });
    expect(out.csv).toContain('Bulk Izvoz A d.o.o.');
    expect(out.csv).toContain('Bulk Izvoz B d.o.o.');
    expect(out.csv).not.toContain('Nije Izabran');
  });
});

describe('golden/db: reports (5.2)', () => {
  it('aging by customer equals invoice positions; disputed shown separately', async () => {
    const out = await inTenant(appPool, FX.tenantA, async (db) => {
      const c = await company(db, 'Aging Izvestaj d.o.o.');
      const a = await invoice(db, c, 10, '100.00');
      await invoice(db, c, -5, '50.00');
      await openDispute(ctxFor(db), { customerId: c, invoiceIds: [a], reasonCode: 'pricing' });
      const r = await runReport(ctxFor(db), 'aging_by_customer');
      return r.rows.find((row) => row.customer === 'Aging Izvestaj d.o.o.');
    });
    expect(out).toMatchObject({
      open_total: '150.00',
      overdue_total: '100.00',
      disputed: '100.00',
    });
  });

  it('collected by period counts payments in scope only', async () => {
    const out = await inTenant(appPool, FX.tenantA, async (db) => {
      const mine = await company(db, 'Naplata Moj d.o.o.', FX.userA2);
      const theirs = await company(db, 'Naplata Tudji d.o.o.', FX.userA);
      await invoice(db, mine, 3, '80.00');
      await invoice(db, theirs, 3, '80.00');
      const today =
        (await db.query<{ d: string }>(`SELECT (now() AT TIME ZONE 'UTC')::date::text AS d`))
          .rows[0]?.d ?? '';
      const org = ctxFor(db);
      await recordPayment(org, {
        customerId: mine,
        amount: '30.00',
        currency: 'EUR',
        paidOn: today,
      });
      await recordPayment(org, {
        customerId: theirs,
        amount: '45.00',
        currency: 'EUR',
        paidOn: today,
      });
      const own = await runReport(ctxFor(db, FX.userA2, 'OWN'), 'collected_by_period', {
        filters: { from: today, to: today, period: 'day' },
      });
      return own.rows;
    });
    expect(out).toEqual([expect.objectContaining({ collected: '30.00', payments: 1 })]);
  });
});

describe('golden/db: settings (5.2)', () => {
  it('aging bounds stay contiguous; a change writes audit + domain event', async () => {
    const out = await inTenant(appPool, FX.tenantA, async (db) => {
      const ctx = ctxFor(db);
      const current = await db.query<{ code: string; min: number; max: number | null }>(
        'SELECT code, min_days_overdue AS min, max_days_overdue AS max FROM aging_bucket_bounds ORDER BY min_days_overdue',
      );
      const gap = current.rows.map((b, i) => (i === 1 ? { ...b, min: b.min + 1 } : b));
      const bad = await saveAgingBounds(ctx, gap).catch((e: unknown) => e);
      const shifted = current.rows.map((b, i, all) =>
        i === 1
          ? { ...b, max: (b.max ?? 0) + 5 }
          : i === 2
            ? { ...b, min: (all[1]?.max ?? 0) + 6 }
            : b,
      );
      await saveAgingBounds(ctx, shifted);
      const audit = await db.query(
        `SELECT 1 FROM audit_log WHERE action = 'settings.aging_buckets_changed' AND request_id = $1`,
        [ctx.requestId],
      );
      const event = await db.query(
        `SELECT 1 FROM domain_events WHERE event_type = 'tenant_settings.updated' AND request_id = $1`,
        [ctx.requestId],
      );
      return { bad, audit: audit.rowCount, event: event.rowCount };
    });
    expect(out.bad).toBeInstanceOf(ConflictError);
    expect(out).toMatchObject({ audit: 1, event: 1 });
  });

  it('a code is deactivated, never deleted; the default policy cannot be deactivated', async () => {
    const out = await inTenant(appPool, FX.tenantA, async (db) => {
      const ctx = ctxFor(db);
      const c = await company(db, 'Razlog Spora d.o.o.');
      const inv = await invoice(db, c, 2);
      await upsertCode(ctx, 'dispute_reason', {
        code: 'golden_reason',
        labels: { 'sr-Latn': 'Zlatni', en: 'Golden' },
      });
      await openDispute(ctx, { customerId: c, invoiceIds: [inv], reasonCode: 'golden_reason' });
      await upsertCode(ctx, 'dispute_reason', {
        code: 'golden_reason',
        labels: { 'sr-Latn': 'Zlatni', en: 'Golden' },
        active: false,
      });
      const row = await db.query<{ is_active: boolean }>(
        `SELECT is_active FROM code_lists WHERE list_key = 'dispute_reason' AND code = 'golden_reason'`,
      );
      const { defaultPolicyCode } = await getThresholds(ctx);
      const policy = await upsertCode(ctx, 'collection_policy', {
        code: defaultPolicyCode,
        labels: { 'sr-Latn': 'X', en: 'X' },
        active: false,
      }).catch((e: unknown) => e);
      const t = await getThresholds(ctx);
      const bands = await saveThresholds(ctx, { ...t, riskBandYellow: 70, riskBandRed: 60 }).catch(
        (e: unknown) => e,
      );
      return { row: row.rows[0], policy, bands };
    });
    expect(out.row).toEqual({ is_active: false });
    expect(out.policy).toBeInstanceOf(ConflictError);
    expect(out.bands).toBeTruthy();
    expect(out.bands).not.toEqual({ ok: true });
  });
});

describe('golden/db: digest (5.2)', () => {
  it('daily "My day" at 07:00 in the member’s zone, once per local date, through the sink', async () => {
    const out = await inTenant(appPool, FX.tenantA, async (db) => {
      await grant(db, ['customer.read']);
      await db.query(
        `UPDATE users SET timezone = 'Europe/Belgrade', locale = 'sr-Latn' WHERE id = $1`,
        [FX.userA],
      );
      await db.query(`UPDATE users SET status = 'disabled' WHERE id <> $1`, [FX.userA]);
      const c = await company(db, 'Digest Kupac d.o.o.');
      await createContact(db, keyring, {
        customerId: c,
        name: 'K',
        email: 'digest@example.test',
        isPrimary: true,
      });
      await invoice(db, c, 400, '9000.00');
      // 2026-10-12 is a Monday; 04:30 UTC = 06:30 in Belgrade (CEST), 05:10 UTC = 07:10.
      const early = await runTenantDigests(job(db), new Date('2026-10-12T04:30:00Z'), keyring);
      const due = await runTenantDigests(job(db), new Date('2026-10-12T05:10:00Z'), keyring);
      const again = await runTenantDigests(job(db), new Date('2026-10-12T09:00:00Z'), keyring);
      const runs = await db.query<{ kind: string; outcome: string; local_date: string }>(
        `SELECT kind, outcome, local_date::text FROM digest_runs WHERE user_id = $1 AND local_date = '2026-10-12' ORDER BY kind`,
        [FX.userA],
      );
      const [mail] = await readOutbox(db, keyring, { kind: 'digest', limit: 1 });
      const transport = await db.query<{ transport: string }>(
        `SELECT transport FROM mail_outbox WHERE kind = 'digest'`,
      );
      return { early, due, again, runs: runs.rows, mail, transport: transport.rows };
    });
    expect(out.early).toEqual({ sent: 0, empty: 0, failed: 0 });
    // Weekly needs report.read — without it the weekly run is recorded as empty.
    expect(out.due).toEqual({ sent: 1, empty: 1, failed: 0 });
    expect(out.again).toEqual({ sent: 0, empty: 0, failed: 0 });
    expect(out.runs).toEqual([
      { kind: 'daily', outcome: 'sent', local_date: '2026-10-12' },
      { kind: 'weekly', outcome: 'empty', local_date: '2026-10-12' },
    ]);
    expect(out.mail?.subject).toBe('Moj dan — naplata');
    expect(out.mail?.to).toBe('user-a@golden.example.test');
    expect(out.transport).toEqual([{ transport: 'sink' }]);
  });

  it('a member who turned the daily digest off gets none', async () => {
    const out = await inTenant(appPool, FX.tenantA, async (db) => {
      await grant(db, ['customer.read']);
      await db.query(`UPDATE users SET status = 'disabled' WHERE id <> $1`, [FX.userA]);
      await savePreferences(ctxFor(db), {
        dailyDigest: false,
        weeklyDigest: false,
        inAppAttention: true,
        inAppMail: true,
      });
      return runTenantDigests(job(db), new Date('2026-10-13T08:00:00Z'), keyring);
    });
    expect(out).toEqual({ sent: 0, empty: 0, failed: 0 });
  });
});

describe('golden/db: getting started (5.4)', () => {
  it('twelve steps detected from data; importing customers ticks the step', async () => {
    const out = await inTenant(appPool, FX.tenantA, async (db) => {
      const before = await onboardingState(ctxFor(db));
      await company(db, 'Onboarding Kupac d.o.o.');
      const after = await onboardingState(ctxFor(db));
      return { before, after };
    });
    expect(out.before.total).toBe(12);
    expect(out.after.steps.find((s) => s.key === 'customers')?.done).toBe(true);
    expect(out.after.steps.find((s) => s.key === 'owners')?.done).toBe(true);
    expect(out.after.done).toBeGreaterThanOrEqual(out.before.done);
  });
});
