import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listAttention } from '@/server/attention/service';
import { writeAudit, type AuditEntry } from '@/server/auth/audit';
import type { Scope } from '@/server/auth/permissions';
import {
  ConflictError,
  InvalidRequestError,
  NotFoundError,
  type TenantContext,
} from '@/server/auth/with-tenant';
import { parseMasterKeyring } from '@/server/crypto/keyring';
import { createConsumer } from '@/server/customers/repository';
import { generateDocument, readDocument } from '@/server/documents/service';
import { putDocument } from '@/server/documents/storage';
import { createDocumentLink, downloadDocument } from '@/server/exports/service';
import { listTemplates, renderForCustomer, saveTemplateVersion } from '@/server/templates/service';
import { runDailyWorkflows } from '@/server/workflows/engine';
import { createWorkflow, decidePublish, submitForPublish } from '@/server/workflows/service';
import { ensureFixtures, FX } from './fixtures';
import { appPool, closePools, inTenant, inTenantCommit, migratePool } from './helpers';

// Golden (never delete or skip) — task 3.2: a template reads only whitelisted fields and only
// customers the caller may see (own tenant, own scope); values are escaped; documents are stored
// encrypted and leave only through exportService with export_log (rule 12); a message with
// legal effect never goes to a natural person by a rule (rule 19); attention is scoped.

const keyring = parseMasterKeyring(`1:${randomBytes(32).toString('base64')}`);
const DIR = mkdtempSync(join(tmpdir(), 'golden-docs-'));
process.env.DOCUMENTS_DIR = DIR;

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
): TenantContext {
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

async function company(db: PoolClient, name: string, owner: string | null = null): Promise<string> {
  const le = await db.query<{ id: string }>(
    `SELECT find_or_create_legal_entity('XX', $1, $2, 'UTC', NULL) AS id`,
    [`COM-${randomUUID().slice(0, 12)}`, name],
  );
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO customers (tenant_id, legal_entity_id, display_name, owner_user_id) VALUES ($1, $2, $3, $4) RETURNING id`,
    [FX.tenantA, le.rows[0]?.id, name, owner],
  );
  return rows[0]?.id ?? '';
}

async function overdue(
  db: PoolClient,
  customerId: string,
  days: number,
  total = '1234.50',
): Promise<void> {
  await db.query(
    `INSERT INTO invoices (tenant_id, company_id, customer_id, source_id, external_id, number, issue_date, due_date,
                           currency, amount_total, amount_open)
     SELECT $1, $2, $3, s.id, $4, $4, (now() AT TIME ZONE 'UTC')::date - $5::int - 30,
            (now() AT TIME ZONE 'UTC')::date - $5::int, 'EUR', $6, $6
     FROM data_sources s WHERE s.name = 'file-import'`,
    [FX.tenantA, FX.companyA, customerId, `COM-${randomUUID().slice(0, 8)}`, days, total],
  );
}

describe('golden/db: templates', () => {
  it('a new version rejects fields outside the whitelist and unsafe markup; a good text is a new version', async () => {
    const out = await inTenant(appPool, FX.tenantA, async (db) => {
      const ctx = ctxFor(db);
      const tpl = (await listTemplates(ctx)).find((t) => t.key === 'reminder_overdue');
      const id = tpl?.id ?? '';
      const field = await saveTemplateVersion(ctx, id, {
        texts: [{ locale: 'sr-Latn', subject: 'S', body: '<p>{{customer.iban}}</p>' }],
      }).catch((e: unknown) => e);
      const script = await saveTemplateVersion(ctx, id, {
        texts: [{ locale: 'sr-Latn', subject: 'S', body: '<script>x</script>' }],
      }).catch((e: unknown) => e);
      const ok = await saveTemplateVersion(ctx, id, {
        texts: [
          {
            locale: 'sr-Latn',
            subject: 'Dug {{customer.overdue_total}}',
            body: '<p>{{customer.name}}</p>',
          },
        ],
      });
      return { field, script, ok, before: tpl?.version };
    });
    expect(out.field).toBeInstanceOf(InvalidRequestError);
    expect(out.script).toBeInstanceOf(InvalidRequestError);
    expect(out.ok.version).toBe((out.before ?? 0) + 1);
  });

  it('cannot render another tenant’s or an out-of-scope customer; values are escaped and localized', async () => {
    const out = await inTenant(appPool, FX.tenantA, async (db) => {
      const mine = await company(db, 'Alfa <b>& Co</b>', FX.userA);
      await overdue(db, mine, 10);
      await db.query(`UPDATE customers SET language = 'en' WHERE id = $1`, [mine]);
      const render = (ctx: TenantContext, customerId: string) =>
        renderForCustomer(
          ctx,
          { key: 'reminder_second', channel: 'email', customerId, permission: 'customer.read' },
          keyring,
        ).catch((e: unknown) => e);
      return {
        own: await render(ctxFor(db), mine),
        foreign: await render(ctxFor(db), FX.customerB),
        outOfScope: await render(ctxFor(db, FX.userA2, 'OWN'), mine),
      };
    });
    expect(out.foreign).toBeInstanceOf(NotFoundError);
    expect(out.outOfScope).toBeInstanceOf(NotFoundError);
    const own = out.own as { html: string; locale: string };
    expect(own.locale).toBe('en');
    expect(own.html).toContain('€1,234.50');
    expect(own.html).not.toContain('<b>&');
  });
});

describe('golden/db: documents and exportService', () => {
  it('a document is stored encrypted, readable only in scope; HTML is not exportable yet', async () => {
    const out = await inTenant(appPool, FX.tenantA, async (db) => {
      const c = await company(db, 'Beta Plaintext Check d.o.o.', FX.userA);
      await overdue(db, c, 20);
      const ctx = ctxFor(db);
      const { id } = await generateDocument(ctx, c, { kind: 'dunning_letter' }, keyring);
      const files = readdirSync(join(DIR, FX.tenantA));
      const raw = readFileSync(join(DIR, FX.tenantA, `${id}.bin`)).toString('latin1');
      const doc = await readDocument(ctx, id, keyring);
      const other = await readDocument(ctxFor(db, FX.userA2, 'OWN'), id, keyring).catch(
        (e: unknown) => e,
      );
      const link = await createDocumentLink(ctx, id, { purpose: 'internal_review' }, keyring).catch(
        (e: unknown) => e,
      );
      return {
        files: files.includes(`${id}.bin`),
        raw,
        html: doc.content.toString('utf8'),
        other,
        link,
      };
    });
    expect(out.files).toBe(true);
    expect(out.raw).not.toContain('Plaintext Check');
    expect(out.html).toContain('Beta Plaintext Check');
    expect(out.html).not.toContain('<script');
    expect(out.other).toBeInstanceOf(NotFoundError);
    expect(out.link).toBeInstanceOf(ConflictError);
  });

  it('a signed link downloads once per request with export_log; tampered, foreign or expired links are 404', async () => {
    const out = await inTenant(appPool, FX.tenantA, async (db) => {
      const c = await company(db, 'Gama', FX.userA);
      const tpl = await db.query<{ id: string }>(
        `SELECT id FROM templates WHERE key = 'statement' AND status = 'active'`,
      );
      const id = randomUUID();
      const content = Buffer.from('%PDF-1.4 golden');
      const stored = putDocument(keyring, FX.tenantA, id, content);
      await db.query(
        `INSERT INTO documents (id, tenant_id, customer_id, kind, template_id, format, locale, version, checksum, size_bytes,
                                storage_ref, key_version)
         VALUES ($1, $2, $3, 'statement', $4, 'pdf', 'sr-Latn', 1, sha256($5::bytea), $6, $7, $8)`,
        [
          id,
          FX.tenantA,
          c,
          tpl.rows[0]?.id,
          content,
          content.length,
          stored.storageRef,
          stored.keyVersion,
        ],
      );
      const ctx = ctxFor(db);
      const now = new Date();
      const { url } = await createDocumentLink(
        ctx,
        id,
        { purpose: 'customer_correspondence' },
        keyring,
        now,
      );
      const token = new URL(url, 'http://x').searchParams.get('token') ?? '';
      const file = await downloadDocument(ctx, id, token, keyring, now);
      const log = await db.query<{
        export_type: string;
        format: string;
        purpose: string;
        row_count: number;
      }>(
        `SELECT export_type, format, purpose, row_count FROM export_log WHERE filters->>'document_id' = $1`,
        [id],
      );
      const tampered = await downloadDocument(
        ctx,
        id,
        token.replace(/^./, (ch) => (ch === 'A' ? 'B' : 'A')),
        keyring,
        now,
      ).catch((e: unknown) => e);
      const otherUser = await downloadDocument(
        ctxFor(db, FX.userA2),
        id,
        token,
        keyring,
        now,
      ).catch((e: unknown) => e);
      const later = await downloadDocument(
        ctx,
        id,
        token,
        keyring,
        new Date(now.getTime() + 301_000),
      ).catch((e: unknown) => e);
      return { body: file.content.toString(), log: log.rows, tampered, otherUser, later };
    });
    expect(out.body).toBe('%PDF-1.4 golden');
    expect(out.log).toEqual([
      {
        export_type: 'document.statement',
        format: 'pdf',
        purpose: 'customer_correspondence',
        row_count: 1,
      },
    ]);
    expect(out.tampered).toBeInstanceOf(NotFoundError);
    expect(out.otherUser).toBeInstanceOf(NotFoundError);
    expect(out.later).toBeInstanceOf(NotFoundError);
  });
});

describe('golden/db: rule 19 for messages and attention', () => {
  it('a rule never sends a message with legal effect to a natural person', async () => {
    const out = await inTenant(appPool, FX.tenantA, async (db) => {
      const person = await createConsumer(db, keyring, { displayName: 'Golden Person' });
      await overdue(db, person.id, 3);
      const ctx = ctxFor(db);
      const { id } = await createWorkflow(ctx, {
        name: 'Golden legal email D+3',
        definition: {
          trigger: { type: 'days_from_due', offset: 3 },
          conditions: [],
          actions: [{ type: 'queue_email', template: 'pre_litigation_notice' }],
        },
      });
      const { approvalId } = await submitForPublish(ctx, id);
      await decidePublish(ctxFor(db, FX.userA2), approvalId, { decision: 'approve' });
      await runDailyWorkflows(db, (e: AuditEntry) =>
        writeAudit(db, { type: 'job', id: null }, e, null),
      );
      const res = await db.query<{ result: Record<string, unknown> }>(
        `SELECT a.result FROM workflow_run_actions a JOIN workflow_runs r ON r.id = a.run_id
         JOIN workflow_versions v ON v.id = r.workflow_version_id WHERE v.workflow_id = $1`,
        [id],
      );
      return res.rows.map((r) => r.result.reason);
    });
    expect(out).toEqual(['rule_19']);
  });

  it('attention lists a broken promise in scope only, and never another tenant’s', async () => {
    const out = await inTenant(appPool, FX.tenantA, async (db) => {
      const mine = await company(db, 'Delta', FX.userA2);
      const theirs = await company(db, 'Epsilon', FX.userA);
      for (const c of [mine, theirs]) {
        await db.query(
          `INSERT INTO promises (tenant_id, customer_id, company_id, amount, currency, promised_on, made_on, status,
                                 paid_amount, evaluated_at)
           VALUES ($1, $2, $3, '10.00', 'EUR', current_date - 2, current_date - 5, 'broken', 0, now())`,
          [FX.tenantA, c, FX.companyA],
        );
      }
      const own = await listAttention(ctxFor(db, FX.userA2, 'OWN'));
      await db.query("SELECT set_config('app.tenant_id', $1, true)", [FX.tenantB]);
      const b = await listAttention({
        ...ctxFor(db, FX.userB, 'ORGANIZATION'),
        tenantId: FX.tenantB,
      });
      return {
        own: own.filter((i) => i.kind === 'promise_broken').map((i) => i.customerId),
        mine,
        b: b.filter((i) => [mine, theirs].includes(i.customerId ?? '')).length,
      };
    });
    expect(out.own).toEqual([out.mine]);
    expect(out.b).toBe(0);
  });
});
