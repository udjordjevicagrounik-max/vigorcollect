import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { queuedRender } from '@/server/documents/render-queue';
import { renderNext } from '@/server/documents/renderer';
import { ensureFixtures, FX } from './fixtures';
import {
  appPool,
  closePools,
  inTenant,
  inTenantCommit,
  migratePool,
  sqlState,
  workerPool,
} from './helpers';

// Golden (never delete or skip) — review S-10: Chromium runs only in the renderer service, whose
// database role (vigor_renderer, migration 021) reaches render_jobs and NOTHING else; the worker
// hands the HTML over and gets the PDF back; no job outlives its hour; tenants never see each
// other's jobs.

function rendererUrl(): string {
  const url = new URL(process.env.TEST_DATABASE_URL ?? '');
  url.username = 'vigor_renderer';
  url.password = process.env.RENDERER_DB_PASSWORD ?? '';
  return url.toString();
}
const renderer = new Pool({ connectionString: rendererUrl(), max: 2 });

let documentId = '';
let templateId = '';
const AT = new Date('2026-10-13T08:00:00Z');

beforeAll(async () => {
  await ensureFixtures();
  await inTenantCommit(migratePool, FX.tenantA, async (db) => {
    const t = await db.query<{ id: string }>(
      `INSERT INTO templates (tenant_id, key, channel, name, version)
       VALUES ($1, $2, 'document', 'Golden render', 1) RETURNING id`,
      [FX.tenantA, `golden_render_${randomUUID().slice(0, 8)}`],
    );
    templateId = t.rows[0]?.id ?? '';
    const d = await db.query<{ id: string }>(
      `INSERT INTO documents (tenant_id, customer_id, kind, template_id, format, locale, version, checksum,
                              size_bytes, storage_ref, key_version)
       VALUES ($1, $2, 'dunning_letter', $3, 'html', 'sr-Latn',
               (SELECT coalesce(max(version), 0) + 1 FROM documents WHERE customer_id = $2 AND kind = 'dunning_letter'),
               $4, 10, 'file:golden/render', 1) RETURNING id`,
      [FX.tenantA, FX.customerA, templateId, randomBytes(32)],
    );
    documentId = d.rows[0]?.id ?? '';
  });
});

afterAll(async () => {
  await inTenantCommit(migratePool, FX.tenantA, async (db) => {
    await db.query('DELETE FROM render_jobs WHERE document_id = $1', [documentId]);
    await db.query('DELETE FROM documents WHERE id = $1', [documentId]);
    await db.query('DELETE FROM templates WHERE id = $1', [templateId]);
  });
  await renderer.end();
  await closePools();
});

describe('golden/db: the renderer role reaches render_jobs and nothing else', () => {
  it('every other table, insert, delete and the job tenant are refused (42501)', async () => {
    const tables = [
      'customers',
      'documents',
      'document_renditions',
      'users',
      'tenants',
      'mail_outbox',
      'legal_entities',
      'audit_log',
      'subject_keys',
      'integration_credentials',
      'auth."session"',
      'auth."account"',
    ];
    const states: Record<string, string> = {};
    for (const t of tables)
      states[t] = await sqlState(renderer.query(`SELECT 1 FROM ${t} LIMIT 1`));
    expect(states).toEqual(Object.fromEntries(tables.map((t) => [t, '42501'])));
    expect(await sqlState(renderer.query('SELECT tenant_id FROM render_jobs LIMIT 1'))).toBe(
      '42501',
    );
    expect(
      await sqlState(
        renderer.query(
          `INSERT INTO render_jobs (tenant_id, document_id, html_in) VALUES ($1, $2, 'x')`,
          [FX.tenantA, documentId],
        ),
      ),
    ).toBe('42501');
    expect(await sqlState(renderer.query('DELETE FROM render_jobs'))).toBe('42501');
    const role = await renderer.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });
});

describe('golden/db: worker → renderer → worker through render_jobs', () => {
  it('the PDF comes back with pinned dates and the job row is gone afterwards', async () => {
    const seen: string[] = [];
    const fakeChromium = async (html: string) => {
      seen.push(html);
      return {
        pdf: Buffer.from("%PDF-1.4 /CreationDate (D:20991231235959+00'00') golden", 'latin1'),
        renderer: 'chromium/155.0.golden',
      };
    };
    let stop = false;
    const loop = (async () => {
      while (!stop) {
        if (!(await renderNext(renderer, fakeChromium)))
          await new Promise((r) => setTimeout(r, 50));
      }
    })();
    try {
      const result = await queuedRender(appPool, { pollMs: 50, timeoutMs: 10_000 })(
        '<p>Poštovani</p>',
        AT,
        { tenantId: FX.tenantA, documentId },
      );
      expect(seen).toEqual(['<p>Poštovani</p>']);
      expect(result.renderer).toBe('chromium/155.0.golden');
      expect(result.pdf.toString('latin1')).toContain("/CreationDate (D:20261013080000+00'00')");
    } finally {
      stop = true;
      await loop;
    }
    const left = await inTenant(appPool, FX.tenantA, (db) =>
      db.query('SELECT 1 FROM render_jobs WHERE document_id = $1', [documentId]),
    );
    expect(left.rowCount).toBe(0);
  });

  it('no renderer answer → timeout, and the HTML does not stay behind', async () => {
    await expect(
      queuedRender(appPool, { pollMs: 50, timeoutMs: 300 })('<p>x</p>', AT, {
        tenantId: FX.tenantA,
        documentId,
      }),
    ).rejects.toThrow('render: timeout');
    const left = await inTenant(appPool, FX.tenantA, (db) =>
      db.query('SELECT 1 FROM render_jobs WHERE document_id = $1', [documentId]),
    );
    expect(left.rowCount).toBe(0);
  });
});

describe('golden/db: render jobs are tenant-isolated and live at most an hour', () => {
  it('tenant B never sees tenant A jobs; an expired job is invisible to the renderer and retention removes it', async () => {
    let fresh = '';
    let expired = '';
    await inTenantCommit(appPool, FX.tenantA, async (db) => {
      const a = await db.query<{ id: string }>(
        `INSERT INTO render_jobs (tenant_id, document_id, html_in) VALUES (app_tenant_id(), $1, '<p>A</p>') RETURNING id`,
        [documentId],
      );
      fresh = a.rows[0]?.id ?? '';
      const b = await db.query<{ id: string }>(
        `INSERT INTO render_jobs (tenant_id, document_id, html_in, created_at, expires_at)
         VALUES (app_tenant_id(), $1, '<p>old</p>', now() - interval '2 hours', now() - interval '1 hour') RETURNING id`,
        [documentId],
      );
      expired = b.rows[0]?.id ?? '';
    });
    try {
      const fromB = await inTenant(appPool, FX.tenantB, (db) =>
        db.query('SELECT 1 FROM render_jobs WHERE id = ANY($1)', [[fresh, expired]]),
      );
      expect(fromB.rowCount).toBe(0);
      const visible = await renderer.query<{ id: string }>(
        'SELECT id FROM render_jobs WHERE id = ANY($1)',
        [[fresh, expired]],
      );
      expect(visible.rows.map((r) => r.id)).toEqual([fresh]);
      expect(
        await sqlState(
          inTenant(appPool, FX.tenantA, (db) =>
            db.query(
              `INSERT INTO render_jobs (tenant_id, document_id, html_in, expires_at)
               VALUES (app_tenant_id(), $1, 'x', now() + interval '2 hours')`,
              [documentId],
            ),
          ),
        ),
      ).toBe('23514'); // render_jobs_lifetime
      const deleted = await workerPool().query('DELETE FROM render_jobs WHERE expires_at < now()');
      expect(deleted.rowCount).toBeGreaterThanOrEqual(1);
      const stillThere = await inTenant(appPool, FX.tenantA, (db) =>
        db.query<{ id: string }>('SELECT id FROM render_jobs WHERE id = ANY($1)', [
          [fresh, expired],
        ]),
      );
      expect(stillThere.rows.map((r) => r.id)).toEqual([fresh]);
    } finally {
      await inTenantCommit(appPool, FX.tenantA, async (db) => {
        await db.query('DELETE FROM render_jobs WHERE id = ANY($1)', [[fresh, expired]]);
      });
    }
  });
});
