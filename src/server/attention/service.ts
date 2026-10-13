import { z } from 'zod';
import { permissionKeys } from '@/server/auth/permissions';
import { scopeFilter } from '@/server/auth/scope';
import { NotFoundError, type TenantContext } from '@/server/auth/with-tenant';
import { CHECKER } from '@/server/approvals/service';
import { listRuleProposals } from '@/server/decisions/service';

/**
 * Attention (task 3.2) — ONE list of things that need a person, each with its action:
 *   about customers (view attention_customer_items, scoped through scopeFilter): broken promise,
 *   no activity for N days, large overdue invoice, unassigned case;
 *   about me: approvals I may decide, my open tasks due, unread notifications;
 *   rule proposals (3.3) waiting for a person to submit them (decision.create / approval.create);
 *   about the tenant (with the right permission): failed rule runs (settings.read), open import
 *   exceptions (import.read).
 * Thresholds are tenant settings (attention_no_activity_days, attention_large_overdue).
 */

export const ATTENTION_KINDS = [
  'approval_pending',
  'rule_proposal',
  'mail_undelivered',
  'risk_red',
  'promise_broken',
  'workflow_failed',
  'large_overdue',
  'import_exception',
  'task_due',
  'no_activity',
  'unassigned_case',
  'notification',
] as const;
export type AttentionKind = (typeof ATTENTION_KINDS)[number];

export type AttentionItem = {
  kind: AttentionKind;
  refId: string;
  customerId: string | null;
  customerName: string | null;
  caseId: string | null;
  since: string | null;
  amount: string | null;
  currency: string | null;
  code: string | null;
  severity: number;
};

export async function listAttention(ctx: TenantContext, limit = 50): Promise<AttentionItem[]> {
  const { scope } = await ctx.requirePermission('customer.read');
  const keys = await permissionKeys(ctx.db, ctx.userId);
  const filter = scopeFilter('customers', { userId: ctx.userId, scope }, 'c', 2);
  const items: AttentionItem[] = [];

  const customerItems = await ctx.db.query<{
    kind: AttentionKind;
    ref_id: string;
    customer_id: string;
    customer_name: string | null;
    case_id: string | null;
    since: Date | null;
    amount: string | null;
    currency: string | null;
    severity: number;
  }>(
    `SELECT a.kind, a.ref_id, a.customer_id, c.display_name AS customer_name, a.case_id, a.since,
            a.amount::text, a.currency, a.severity
     FROM attention_customer_items a JOIN customers c ON c.id = a.customer_id AND ${filter.sql}
     ORDER BY a.severity DESC, a.amount DESC NULLS LAST LIMIT $1`,
    [limit, ...filter.params],
  );
  for (const r of customerItems.rows) {
    items.push({
      kind: r.kind,
      refId: r.ref_id,
      customerId: r.customer_id,
      customerName: r.customer_name,
      caseId: r.case_id,
      since: r.since?.toISOString() ?? null,
      amount: r.amount,
      currency: r.currency,
      code: null,
      severity: r.severity,
    });
  }

  // Approvals I may decide (never my own request).
  const checkerTypes = Object.entries(CHECKER)
    .filter(([, key]) => keys.has(key))
    .map(([type]) => type);
  if (checkerTypes.length) {
    const ap = await ctx.db.query<{ id: string; action_type: string; created_at: Date }>(
      `SELECT id, action_type, created_at FROM approval_requests
       WHERE status = 'pending' AND requested_by <> $1 AND action_type = ANY($2::text[])
       ORDER BY created_at LIMIT 20`,
      [ctx.userId, checkerTypes],
    );
    for (const r of ap.rows) {
      items.push({
        kind: 'approval_pending',
        refId: r.id,
        customerId: null,
        customerName: null,
        caseId: null,
        since: r.created_at.toISOString(),
        amount: null,
        currency: null,
        code: r.action_type,
        severity: 3,
      });
    }
  }

  // 4.3: a customer whose risk band turned red in the last 7 days (latest score red, previous not).
  {
    const rf = scopeFilter('customers', { userId: ctx.userId, scope }, 'c', 1);
    const red = await ctx.db.query<{
      id: string;
      customer_id: string;
      customer_name: string | null;
      computed_at: Date;
      score: number;
    }>(
      `SELECT s.id, s.customer_id, c.display_name AS customer_name, s.computed_at, s.score
       FROM customers c
       JOIN LATERAL (SELECT * FROM risk_scores x WHERE x.customer_id = c.id ORDER BY x.computed_at DESC LIMIT 1) s ON true
       WHERE ${rf.sql} AND s.band = 'red' AND coalesce(s.previous_band, 'green') <> 'red'
         AND s.computed_at > now() - interval '7 days'
       ORDER BY s.score DESC LIMIT 20`,
      rf.params,
    );
    for (const r of red.rows) {
      items.push({
        kind: 'risk_red',
        refId: r.id,
        customerId: r.customer_id,
        customerName: r.customer_name,
        caseId: null,
        since: r.computed_at.toISOString(),
        amount: null,
        currency: null,
        code: String(r.score),
        severity: 3,
      });
    }
  }

  // 4.2: our mail bounced or failed for good (last 14 days), for customers in scope.
  if (keys.has('activity.read')) {
    const mf = scopeFilter('customers', { userId: ctx.userId, scope }, 'c', 1);
    const undelivered = await ctx.db.query<{
      id: string;
      customer_id: string;
      customer_name: string | null;
      case_id: string | null;
      at: Date;
      status: string;
    }>(
      `SELECT m.id, m.customer_id, c.display_name AS customer_name, m.case_id,
              coalesce(m.bounced_at, m.updated_at) AS at, m.status
       FROM mail_outbox m JOIN customers c ON c.id = m.customer_id AND ${mf.sql}
       WHERE m.status IN ('bounced', 'failed') AND m.customer_id IS NOT NULL
         AND coalesce(m.bounced_at, m.updated_at) > now() - interval '14 days'
       ORDER BY at DESC LIMIT 20`,
      mf.params,
    );
    for (const r of undelivered.rows) {
      items.push({
        kind: 'mail_undelivered',
        refId: r.id,
        customerId: r.customer_id,
        customerName: r.customer_name,
        caseId: r.case_id,
        since: r.at.toISOString(),
        amount: null,
        currency: null,
        code: r.status,
        severity: 3,
      });
    }
  }

  // Rule proposals (rule 19: a rule only recommends) — a person submits them for approval.
  if (keys.has('decision.create') || keys.has('approval.create')) {
    for (const p of await listRuleProposals(ctx, scope)) {
      items.push({
        kind: 'rule_proposal',
        refId: p.id,
        customerId: p.customerId,
        customerName: p.naturalPerson ? null : p.customerName,
        caseId: p.caseId,
        since: p.createdAt,
        amount: null,
        currency: null,
        code: p.decisionType,
        severity: 3,
      });
    }
  }

  const tasks = await ctx.db.query<{
    id: string;
    customer_id: string;
    customer_name: string | null;
    case_id: string | null;
    due_on: string;
    kind_code: string;
  }>(
    `SELECT t.id, t.customer_id, c.display_name AS customer_name, t.case_id, t.due_on::text, t.kind_code
     FROM tasks t JOIN customers c ON c.id = t.customer_id
     WHERE t.assignee_user_id = $1 AND t.status = 'open'
       AND t.due_on <= (SELECT (now() AT TIME ZONE ts.timezone)::date FROM tenant_settings ts)
     ORDER BY t.due_on LIMIT 20`,
    [ctx.userId],
  );
  for (const r of tasks.rows) {
    items.push({
      kind: 'task_due',
      refId: r.id,
      customerId: r.customer_id,
      customerName: r.customer_name,
      caseId: r.case_id,
      since: r.due_on,
      amount: null,
      currency: null,
      code: r.kind_code,
      severity: 2,
    });
  }

  const notes = await ctx.db.query<{
    id: string;
    message_key: string;
    customer_id: string | null;
    case_id: string | null;
    created_at: Date;
  }>(
    `SELECT id, message_key, customer_id, case_id, created_at FROM notifications
     WHERE user_id = $1 AND read_at IS NULL ORDER BY created_at DESC LIMIT 20`,
    [ctx.userId],
  );
  for (const r of notes.rows) {
    items.push({
      kind: 'notification',
      refId: r.id,
      customerId: r.customer_id,
      customerName: null,
      caseId: r.case_id,
      since: r.created_at.toISOString(),
      amount: null,
      currency: null,
      code: r.message_key,
      severity: 1,
    });
  }

  if (keys.has('settings.read')) {
    const failed = await ctx.db.query<{
      id: string;
      workflow_id: string;
      started_at: Date;
      error_code: string | null;
    }>(
      `SELECT r.id, v.workflow_id, r.started_at, r.error_code FROM workflow_runs r
       JOIN workflow_versions v ON v.id = r.workflow_version_id
       WHERE r.status = 'failed' AND r.started_at > now() - interval '7 days'
       ORDER BY r.started_at DESC LIMIT 10`,
    );
    for (const r of failed.rows) {
      items.push({
        kind: 'workflow_failed',
        refId: r.workflow_id,
        customerId: null,
        customerName: null,
        caseId: null,
        since: r.started_at.toISOString(),
        amount: null,
        currency: null,
        code: r.error_code,
        severity: 3,
      });
    }
  }
  if (keys.has('import.read')) {
    const ex = await ctx.db.query<{ run_id: string; n: number; since: Date }>(
      `SELECT run_id, count(*)::int AS n, min(created_at) AS since FROM reconciliation_exceptions
       WHERE status = 'open' GROUP BY run_id ORDER BY min(created_at) DESC LIMIT 10`,
    );
    for (const r of ex.rows) {
      items.push({
        kind: 'import_exception',
        refId: r.run_id,
        customerId: null,
        customerName: null,
        caseId: null,
        since: r.since.toISOString(),
        amount: null,
        currency: null,
        code: String(r.n),
        severity: 2,
      });
    }
  }
  return items.sort((a, b) => b.severity - a.severity).slice(0, limit);
}

export const notificationReadSchema = z.object({ read: z.literal(true) });
export const taskUpdateSchema = z.object({ status: z.enum(['done', 'cancelled']) });

/** Marks one of MY notifications read (someone else's id: 404). */
export async function markNotificationRead(ctx: TenantContext, id: string) {
  await ctx.requirePermission('customer.read');
  const res = await ctx.db.query(
    'UPDATE notifications SET read_at = now() WHERE id = $1 AND user_id = $2 AND read_at IS NULL',
    [id, ctx.userId],
  );
  if (!res.rowCount) throw new NotFoundError();
  await ctx.audit({ action: 'notification.read', entityType: 'notifications', entityId: id });
  return { ok: true };
}

/** Closes one of MY tasks (activity.create — the same people who log the work). */
export async function updateTask(
  ctx: TenantContext,
  id: string,
  input: z.input<typeof taskUpdateSchema>,
) {
  await ctx.requirePermission('activity.create');
  const { status } = taskUpdateSchema.parse(input);
  const res = await ctx.db.query(
    `UPDATE tasks SET status = $3, completed_at = CASE WHEN $3 = 'done' THEN now() END, updated_by = $2
     WHERE id = $1 AND assignee_user_id = $2 AND status = 'open'`,
    [id, ctx.userId, status],
  );
  if (!res.rowCount) throw new NotFoundError();
  await ctx.audit({
    action: `task.${status}`,
    entityType: 'tasks',
    entityId: id,
    after: { status },
  });
  return { ok: true };
}
