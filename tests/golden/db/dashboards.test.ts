import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeAudit } from '@/server/auth/audit';
import type { Scope } from '@/server/auth/permissions';
import { NotFoundError, type TenantContext } from '@/server/auth/with-tenant';
import {
  addWidget,
  clearDashboardCache,
  dashboardData,
  homeDashboardId,
  listDashboards,
  removeWidget,
} from '@/server/dashboards/service';
import { saveReportDefinition } from '@/server/reporting/service';
import { ensureFixtures, FX } from './fixtures';
import {
  appPool,
  closePools,
  inTenant,
  inTenantCommit,
  migratePool,
  savepointState,
} from './helpers';

// Golden (never delete or skip) — task 6.3:
//   - every tenant has the system "Collections overview" (the 2.3 dashboard as widgets), read-only;
//   - "Add to dashboard" on the system home makes a personal copy (home) and adds there;
//   - a private dashboard is invisible to another member; a report widget runs in the member's scope;
//   - widget data is cached 5 minutes per (dashboard, member); Refresh recomputes.

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

describe('golden/db: dashboards (6.3)', () => {
  // Regression (6.5): the 029 backfill ran before RLS on dashboards and its "already there?" check
  // had no tenant — only the first tenant got the system dashboard.
  it('every provisioned tenant has the system dashboard after the migration', async () => {
    const c = await migratePool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.tenant_clock', 'on', true)");
      const { rows } = await c.query<{ id: string }>('SELECT id FROM tenants');
      const missing: string[] = [];
      for (const t of rows) {
        await c.query("SELECT set_config('app.tenant_id', $1, true)", [t.id]);
        const r = await c.query<{ provisioned: boolean; dash: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM code_lists WHERE list_key = 'aging_bucket') AS provisioned,
                  EXISTS (SELECT 1 FROM dashboards WHERE is_system AND system_key = 'collections_overview') AS dash`,
        );
        if (r.rows[0]?.provisioned && !r.rows[0].dash) missing.push(t.id);
      }
      expect(missing).toEqual([]);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  it('the system dashboard is the home by default, holds the 2.3 widgets and is read-only', async () => {
    const out = await inTenant(appPool, FX.tenantA, async (db) => {
      const ctx = ctxFor(db);
      const id = await homeDashboardId(ctx);
      const board = await dashboardData(ctx, id, 'sr-Latn', { refresh: true });
      const upd = await savepointState(db, `UPDATE dashboards SET name = 'x' WHERE id = $1`, [id]);
      const del = await savepointState(
        db,
        `DELETE FROM dashboard_widgets WHERE dashboard_id = $1`,
        [id],
      );
      return { board, upd, del };
    });
    expect(out.board.dashboard.isSystem).toBe(true);
    expect(out.board.widgets.filter((w) => w.kind === 'kpi')).toHaveLength(9);
    expect(out.board.widgets.map((w) => w.kind)).toEqual(
      expect.arrayContaining(['attention', 'aging', 'my_tasks']),
    );
    expect(Object.values(out.board.data).some((d) => d.kind === 'kpi')).toBe(true);
    expect(out.upd).toBe('42501');
    expect(out.del).toBe('42501');
  });

  it('"Add to dashboard" on the system home makes a personal copy, home from then on', async () => {
    const out = await inTenant(appPool, FX.tenantA, async (db) => {
      const ctx = ctxFor(db);
      const { id: reportId } = await saveReportDefinition(ctx, {
        name: 'Widget izveštaj',
        definition: { dataset: 'invoices', measures: [{ field: 'count', agg: 'count' }] },
        visual: 'kpi_number',
      });
      const added = await addWidget(ctx, 'mine', { kind: 'report', reportId, size: 4 });
      const home = await homeDashboardId(ctx);
      const board = await dashboardData(ctx, home, 'sr-Latn', { refresh: true });
      const other = await listDashboards(ctxFor(db, FX.userA2));
      const foreign = await removeWidget(
        ctxFor(db, FX.userA2),
        added.dashboardId,
        added.widgetId,
      ).catch((e: unknown) => e);
      return {
        added,
        home,
        board,
        otherSees: other.some((d) => d.id === added.dashboardId),
        foreign,
      };
    });
    expect(out.home).toBe(out.added.dashboardId);
    expect(out.board.dashboard.isSystem).toBe(false);
    expect(out.board.widgets).toHaveLength(13);
    expect(out.board.data[out.added.widgetId]).toMatchObject({ kind: 'report' });
    expect(out.otherSees).toBe(false);
    expect(out.foreign).toBeInstanceOf(NotFoundError);
  });

  it('widget data is cached 5 minutes per member; Refresh recomputes', async () => {
    clearDashboardCache();
    const out = await inTenant(appPool, FX.tenantA, async (db) => {
      const ctx = ctxFor(db);
      const id = await homeDashboardId(ctx);
      const t0 = 1_000_000;
      const a = await dashboardData(ctx, id, 'sr-Latn', { now: t0 });
      const b = await dashboardData(ctx, id, 'sr-Latn', { now: t0 + 60_000 });
      const c = await dashboardData(ctx, id, 'sr-Latn', { now: t0 + 6 * 60_000 });
      const d = await dashboardData(ctx, id, 'sr-Latn', {
        now: t0 + 6 * 60_000 + 1,
        refresh: true,
      });
      const other = await dashboardData(ctxFor(db, FX.userA2, 'OWN'), id, 'sr-Latn', {
        now: t0 + 1,
      });
      return [a.cachedAt, b.cachedAt, c.cachedAt, d.cachedAt, other.cachedAt];
    });
    expect(out).toEqual([1_000_000, 1_000_000, 1_360_000, 1_360_001, 1_000_001]);
  });

  it('regression: "Needs attention" is live inside the cache window (a new item shows at once)', async () => {
    clearDashboardCache();
    const out = await inTenant(appPool, FX.tenantA, async (db) => {
      const ctx = ctxFor(db);
      const id = await homeDashboardId(ctx);
      const count = async (now: number) => {
        const b = await dashboardData(ctx, id, 'sr-Latn', { now });
        const att = Object.values(b.data).find((d) => d.kind === 'attention');
        return att && att.kind === 'attention'
          ? att.items.filter((i) => i.kind === 'notification').length
          : -1;
      };
      const before = await count(2_000_000);
      await db.query(
        `INSERT INTO notifications (tenant_id, user_id, message_key) VALUES ($1, $2, 'rule_attention')`,
        [FX.tenantA, FX.userA],
      );
      const after = await count(2_000_000 + 1_000);
      return { before, after };
    });
    expect(out.after).toBe(out.before + 1);
  });
});
