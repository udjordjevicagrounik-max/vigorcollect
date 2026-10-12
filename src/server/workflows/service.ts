import { z } from 'zod';
import { PermissionDeniedError } from '@/server/auth/permissions';
import { ConflictError, NotFoundError, type TenantContext } from '@/server/auth/with-tenant';
import { emitEvent } from '@/server/events';
import { definitionSchema, type Definition } from './definition';

/**
 * Admin → Rules (task 3.1). Reading: `settings.read`; editing and proposing: `settings.manage`;
 * deciding a publication: `settings.manage` held by ANOTHER person (four eyes, DB constraint).
 * The catalog has no workflow.* keys yet (NEXT.md / BACKLOG). A published version never changes:
 * an edit is a new draft version; publishing it supersedes the old one only after approval.
 */

export const PUBLISH_ACTION = 'workflow.publish';

export const workflowInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  key: z
    .string()
    .regex(/^[a-z][a-z0-9_]{1,62}$/)
    .optional(),
  definition: definitionSchema,
});
export const draftSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  definition: definitionSchema,
});
export const publishDecisionSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  note: z.string().trim().min(1).max(500).optional(),
});

export type WorkflowSummary = {
  id: string;
  key: string;
  name: string;
  status: string;
  publishedVersion: number | null;
  openVersion: { version: number; status: string } | null;
  runs7d: { succeeded: number; skipped: number; failed: number };
};

export async function listWorkflows(ctx: TenantContext): Promise<WorkflowSummary[]> {
  await ctx.requirePermission('settings.read');
  const { rows } = await ctx.db.query<{
    id: string;
    key: string;
    name: string;
    status: string;
    published: number | null;
    open_version: number | null;
    open_status: string | null;
    succeeded: number;
    skipped: number;
    failed: number;
  }>(
    `SELECT w.id, w.key, w.name, w.status,
            (SELECT v.version FROM workflow_versions v WHERE v.workflow_id = w.id AND v.status = 'published') AS published,
            o.version AS open_version, o.status AS open_status,
            count(r.id) FILTER (WHERE r.status = 'succeeded')::int AS succeeded,
            count(r.id) FILTER (WHERE r.status = 'skipped')::int AS skipped,
            count(r.id) FILTER (WHERE r.status = 'failed')::int AS failed
     FROM workflows w
     LEFT JOIN workflow_versions o ON o.workflow_id = w.id AND o.status IN ('draft', 'pending_approval')
     LEFT JOIN workflow_versions rv ON rv.workflow_id = w.id
     LEFT JOIN workflow_runs r ON r.workflow_version_id = rv.id AND r.started_at > now() - interval '7 days'
     GROUP BY w.id, o.version, o.status
     ORDER BY w.status, w.key`,
  );
  return rows.map((r) => ({
    id: r.id,
    key: r.key,
    name: r.name,
    status: r.status,
    publishedVersion: r.published,
    openVersion: r.open_version
      ? { version: r.open_version, status: r.open_status ?? 'draft' }
      : null,
    runs7d: { succeeded: r.succeeded, skipped: r.skipped, failed: r.failed },
  }));
}

export type WorkflowDetail = {
  id: string;
  key: string;
  name: string;
  status: string;
  versions: {
    id: string;
    version: number;
    status: string;
    definition: Definition | null;
    publishedAt: string | null;
    provisioned: boolean;
    approvalId: string | null;
  }[];
  runs: {
    id: string;
    version: number;
    triggerType: string;
    entityType: string;
    customerId: string | null;
    caseId: string | null;
    status: string;
    errorCode: string | null;
    startedAt: string;
    durationMs: number | null;
    explanation: Record<string, unknown>;
  }[];
};

export async function getWorkflow(ctx: TenantContext, id: string): Promise<WorkflowDetail> {
  await ctx.requirePermission('settings.read');
  const w = await ctx.db.query<{ id: string; key: string; name: string; status: string }>(
    'SELECT id, key, name, status FROM workflows WHERE id = $1',
    [id],
  );
  const wf = w.rows[0];
  if (!wf) throw new NotFoundError();
  const versions = await ctx.db.query<{
    id: string;
    version: number;
    status: string;
    definition: unknown;
    published_at: Date | null;
    provisioned: boolean;
    approval_request_id: string | null;
  }>(
    `SELECT id, version, status, definition, published_at, provisioned, approval_request_id
     FROM workflow_versions WHERE workflow_id = $1 ORDER BY version DESC`,
    [id],
  );
  const runs = await ctx.db.query<{
    id: string;
    version: number;
    trigger_type: string;
    entity_type: string;
    customer_id: string | null;
    case_id: string | null;
    status: string;
    error_code: string | null;
    started_at: Date;
    duration_ms: number | null;
    explanation: Record<string, unknown>;
  }>(
    `SELECT r.id, v.version, r.trigger_type, r.entity_type, r.customer_id, r.case_id, r.status, r.error_code,
            r.started_at, r.duration_ms, r.explanation
     FROM workflow_runs r JOIN workflow_versions v ON v.id = r.workflow_version_id
     WHERE v.workflow_id = $1 ORDER BY r.started_at DESC LIMIT 50`,
    [id],
  );
  return {
    ...wf,
    versions: versions.rows.map((v) => {
      const parsed = definitionSchema.safeParse(v.definition);
      return {
        id: v.id,
        version: v.version,
        status: v.status,
        definition: parsed.success ? parsed.data : null,
        publishedAt: v.published_at?.toISOString() ?? null,
        provisioned: v.provisioned,
        approvalId: v.approval_request_id,
      };
    }),
    runs: runs.rows.map((r) => ({
      id: r.id,
      version: r.version,
      triggerType: r.trigger_type,
      entityType: r.entity_type,
      customerId: r.customer_id,
      caseId: r.case_id,
      status: r.status,
      errorCode: r.error_code,
      startedAt: r.started_at.toISOString(),
      durationMs: r.duration_ms,
      explanation: r.explanation,
    })),
  };
}

function slug(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 50);
  return /^[a-z]/.test(base) ? base : `w_${base || 'rule'}`;
}

async function event(
  ctx: TenantContext,
  type: string,
  id: string,
  payload: Record<string, unknown> = {},
) {
  await emitEvent(ctx.db, {
    eventType: type,
    aggregateType: 'workflows',
    aggregateId: id,
    payload,
    requestId: ctx.requestId,
    actorId: ctx.userId,
  });
}

export async function createWorkflow(
  ctx: TenantContext,
  input: z.input<typeof workflowInputSchema>,
): Promise<{ id: string }> {
  await ctx.requirePermission('settings.manage');
  const data = workflowInputSchema.parse(input);
  const key = data.key ?? slug(data.name);
  const exists = await ctx.db.query('SELECT 1 FROM workflows WHERE key = $1', [key]);
  if (exists.rowCount) throw new ConflictError('conflict');
  const { rows } = await ctx.db.query<{ id: string }>(
    `INSERT INTO workflows (tenant_id, key, name, created_by, updated_by) VALUES (app_tenant_id(), $1, $2, $3, $3) RETURNING id`,
    [key, data.name, ctx.userId],
  );
  const id = rows[0]?.id ?? '';
  await ctx.db.query(
    `INSERT INTO workflow_versions (tenant_id, workflow_id, version, definition, created_by, updated_by)
     VALUES (app_tenant_id(), $1, 1, $2, $3, $3)`,
    [id, data.definition, ctx.userId],
  );
  await ctx.audit({
    action: 'workflow.created',
    entityType: 'workflows',
    entityId: id,
    after: { key, version: 1, status: 'draft' },
  });
  await event(ctx, 'workflow.created', id, { version: 1 });
  return { id };
}

/** Saves the open draft, or starts a new draft version from a published one. */
export async function saveDraft(
  ctx: TenantContext,
  workflowId: string,
  input: z.input<typeof draftSchema>,
): Promise<{ version: number }> {
  await ctx.requirePermission('settings.manage');
  const data = draftSchema.parse(input);
  const w = await ctx.db.query('SELECT 1 FROM workflows WHERE id = $1 FOR UPDATE', [workflowId]);
  if (!w.rowCount) throw new NotFoundError();
  const open = await ctx.db.query<{ id: string; version: number; status: string }>(
    `SELECT id, version, status FROM workflow_versions WHERE workflow_id = $1 AND status IN ('draft', 'pending_approval')`,
    [workflowId],
  );
  const current = open.rows[0];
  if (current?.status === 'pending_approval') throw new ConflictError('conflict');
  let version: number;
  if (current) {
    await ctx.db.query(
      'UPDATE workflow_versions SET definition = $2, updated_by = $3 WHERE id = $1',
      [current.id, data.definition, ctx.userId],
    );
    version = current.version;
  } else {
    const next = await ctx.db.query<{ v: number }>(
      'SELECT coalesce(max(version), 0) + 1 AS v FROM workflow_versions WHERE workflow_id = $1',
      [workflowId],
    );
    version = next.rows[0]?.v ?? 1;
    await ctx.db.query(
      `INSERT INTO workflow_versions (tenant_id, workflow_id, version, definition, created_by, updated_by)
       VALUES (app_tenant_id(), $1, $2, $3, $4, $4)`,
      [workflowId, version, data.definition, ctx.userId],
    );
  }
  if (data.name)
    await ctx.db.query('UPDATE workflows SET name = $2, updated_by = $3 WHERE id = $1', [
      workflowId,
      data.name,
      ctx.userId,
    ]);
  await ctx.audit({
    action: 'workflow.draft_saved',
    entityType: 'workflows',
    entityId: workflowId,
    after: { version, status: 'draft' },
  });
  return { version };
}

/** Maker: the draft goes to approval; it is published only when another person approves. */
export async function submitForPublish(
  ctx: TenantContext,
  workflowId: string,
): Promise<{ approvalId: string }> {
  await ctx.requirePermission('settings.manage');
  const { rows } = await ctx.db.query<{ id: string; version: number; definition: unknown }>(
    `SELECT id, version, definition FROM workflow_versions WHERE workflow_id = $1 AND status = 'draft' FOR UPDATE`,
    [workflowId],
  );
  const draft = rows[0];
  if (!draft) throw new ConflictError('conflict');
  definitionSchema.parse(draft.definition);
  const ar = await ctx.db.query<{ id: string }>(
    `INSERT INTO approval_requests (tenant_id, action_type, entity_type, entity_id, payload, requested_by, request_id, created_by)
     VALUES (app_tenant_id(), $1, 'workflow_versions', $2, jsonb_build_object('workflow_id', $3::uuid, 'version', $4::int), $5, $6, $5)
     RETURNING id`,
    [PUBLISH_ACTION, draft.id, workflowId, draft.version, ctx.userId, ctx.requestId],
  );
  const approvalId = ar.rows[0]?.id ?? '';
  await ctx.db.query(
    `UPDATE workflow_versions SET status = 'pending_approval', approval_request_id = $2, updated_by = $3 WHERE id = $1`,
    [draft.id, approvalId, ctx.userId],
  );
  await ctx.audit({
    action: 'approval_request.created',
    entityType: 'approval_requests',
    entityId: approvalId,
    after: {
      action_type: PUBLISH_ACTION,
      entity_type: 'workflow_versions',
      entity_id: draft.id,
      status: 'pending',
    },
  });
  await event(ctx, 'workflow.publish_requested', workflowId, {
    version: draft.version,
    approval_id: approvalId,
  });
  return { approvalId };
}

/** Checker (routed from approvals/service decideApproval). */
export async function decidePublish(
  ctx: TenantContext,
  approvalId: string,
  input: z.input<typeof publishDecisionSchema>,
): Promise<{ status: 'approved' | 'rejected' }> {
  await ctx.requirePermission('settings.manage');
  const { decision, note } = publishDecisionSchema.parse(input);
  if (decision === 'reject' && !note) throw new ConflictError('invalid_request');
  const { rows } = await ctx.db.query<{ status: string; requested_by: string; entity_id: string }>(
    `SELECT status, requested_by, entity_id FROM approval_requests WHERE id = $1 AND action_type = $2 FOR UPDATE`,
    [approvalId, PUBLISH_ACTION],
  );
  const req = rows[0];
  if (!req) throw new NotFoundError();
  if (req.status !== 'pending') throw new ConflictError('not_pending');
  if (req.requested_by === ctx.userId) throw new PermissionDeniedError();
  const v = await ctx.db.query<{ workflow_id: string; version: number }>(
    `SELECT workflow_id, version FROM workflow_versions WHERE id = $1 AND status = 'pending_approval' FOR UPDATE`,
    [req.entity_id],
  );
  const ver = v.rows[0];
  if (!ver) throw new ConflictError('conflict');
  const status = decision === 'approve' ? 'approved' : 'rejected';
  await ctx.db.query(
    `UPDATE approval_requests SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4, updated_by = $3
     WHERE id = $1`,
    [approvalId, status, ctx.userId, note ?? null],
  );
  if (status === 'approved') {
    await ctx.db.query(
      `UPDATE workflow_versions SET status = 'superseded', updated_by = $2 WHERE workflow_id = $1 AND status = 'published'`,
      [ver.workflow_id, ctx.userId],
    );
    await ctx.db.query(
      `UPDATE workflow_versions SET status = 'published', published_at = now(), published_by = $2, updated_by = $2 WHERE id = $1`,
      [req.entity_id, ctx.userId],
    );
  } else {
    await ctx.db.query(
      `UPDATE workflow_versions SET status = 'rejected', updated_by = $2 WHERE id = $1`,
      [req.entity_id, ctx.userId],
    );
  }
  await ctx.audit({
    action: `approval_request.${status}`,
    entityType: 'approval_requests',
    entityId: approvalId,
    before: { status: 'pending' },
    after: { status, version: ver.version },
  });
  await event(
    ctx,
    status === 'approved' ? 'workflow.published' : 'workflow.publish_rejected',
    ver.workflow_id,
    { version: ver.version },
  );
  return { status };
}
