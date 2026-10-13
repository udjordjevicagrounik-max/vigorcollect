import { PermissionDeniedError } from '@/server/auth/permissions';
import { ConflictError, NotFoundError, type TenantContext } from '@/server/auth/with-tenant';
import type { Queryable } from '@/server/crypto/subject-keys';
import { emitEvent } from '@/server/events';

/**
 * Who may become a checker (security review S-06, rule 11). Granting power that can approve or
 * oversee others needs a SECOND administrator — an invitation or role change to/from one of the
 * privileged roles, a team lead, an API key wider than OWN. The request is an approval_request;
 * another person with `user.assign` (owner/admin, checker-only in the matrix) decides it.
 *
 * Bootstrap: a tenant with EXACTLY ONE active administrator (owner/admin) has nobody to ask, so
 * there the change applies directly; from the second administrator on, four eyes always.
 */

export const PRIVILEGED_ROLES = ['owner', 'admin', 'cfo', 'collection_manager'] as const;
export const ADMIN_ROLE_KEYS = ['owner', 'admin'] as const;

export const isPrivilegedRole = (key: string): boolean =>
  (PRIVILEGED_ROLES as readonly string[]).includes(key);

export const INVITE_ACTION = 'user.invite';
export const TEAM_LEAD_ACTION = 'team.lead_change';
export const API_KEY_SCOPE_ACTION = 'api_key.scope';
/** The checker permission of every request type above. */
export const GOVERNANCE_CHECKER = 'user.assign';

/** Active members holding owner or admin in the current tenant. */
export async function activeAdminCount(db: Queryable): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(DISTINCT u.id)::int AS n
     FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
     WHERE u.status = 'active' AND r.key = ANY($1::text[])`,
    [ADMIN_ROLE_KEYS],
  );
  return rows[0]?.n ?? 0;
}

/** true = a second administrator must approve; false only for the one-admin bootstrap tenant. */
export async function secondAdminRequired(db: Queryable): Promise<boolean> {
  return (await activeAdminCount(db)) !== 1;
}

type Ctx = Pick<TenantContext, 'db' | 'userId' | 'requestId' | 'audit'>;

/** Opens a pending request (one per action + entity); audit + domain event. */
export async function openApproval(
  ctx: Ctx,
  request: {
    actionType: string;
    entityType: string;
    entityId: string;
    /** ids and P0 values only (ADR 0003). */
    payload: Record<string, string | number | boolean | null>;
  },
): Promise<string> {
  const pending = await ctx.db.query(
    `SELECT 1 FROM approval_requests WHERE action_type = $1 AND entity_type = $2 AND entity_id = $3
       AND status = 'pending'`,
    [request.actionType, request.entityType, request.entityId],
  );
  if (pending.rowCount) throw new ConflictError('conflict');
  const { rows } = await ctx.db.query<{ id: string }>(
    `INSERT INTO approval_requests (tenant_id, action_type, entity_type, entity_id, payload,
                                    requested_by, request_id, created_by)
     VALUES (app_tenant_id(), $1, $2, $3, $4::jsonb, $5, $6, $5) RETURNING id`,
    [
      request.actionType,
      request.entityType,
      request.entityId,
      JSON.stringify(request.payload),
      ctx.userId,
      ctx.requestId,
    ],
  );
  const approvalId = rows[0]?.id ?? '';
  await ctx.audit({
    action: 'approval_request.created',
    entityType: 'approval_requests',
    entityId: approvalId,
    after: {
      action_type: request.actionType,
      entity_type: request.entityType,
      entity_id: request.entityId,
      status: 'pending',
    },
  });
  await emitEvent(ctx.db, {
    eventType: 'approval_request.created',
    aggregateType: 'approval_requests',
    aggregateId: approvalId,
    payload: { action_type: request.actionType },
    requestId: ctx.requestId,
    actorId: ctx.userId,
  });
  return approvalId;
}

export type OpenRequest = {
  entityId: string;
  requestedBy: string;
  payload: Record<string, unknown>;
};

/**
 * Checker side, first half: the request of `actionType`, locked, pending, NOT the checker's own;
 * the checker holds `user.assign`. Then the flow applies (or not) and calls closeApproval().
 */
export async function lockApproval(
  ctx: TenantContext,
  approvalId: string,
  actionType: string,
): Promise<OpenRequest> {
  await ctx.requirePermission(GOVERNANCE_CHECKER);
  if (ctx.actorType === 'api_key') throw new PermissionDeniedError();
  const { rows } = await ctx.db.query<{
    action_type: string;
    status: string;
    requested_by: string;
    entity_id: string | null;
    payload: Record<string, unknown>;
  }>(
    `SELECT action_type, status, requested_by, entity_id, payload
     FROM approval_requests WHERE id = $1 FOR UPDATE`,
    [approvalId],
  );
  const r = rows[0];
  if (!r) throw new NotFoundError();
  if (r.action_type !== actionType) throw new ConflictError('unsupported');
  if (r.status !== 'pending') throw new ConflictError('not_pending');
  // The database enforces four eyes as well (approval_requests_four_eyes).
  if (r.requested_by === ctx.userId) throw new PermissionDeniedError();
  if (!r.entity_id) throw new ConflictError('conflict');
  return { entityId: r.entity_id, requestedBy: r.requested_by, payload: r.payload };
}

/** Checker side, second half: records the decision (audit). */
export async function closeApproval(
  ctx: TenantContext,
  approvalId: string,
  status: 'approved' | 'rejected',
  note: string | undefined,
): Promise<void> {
  await ctx.db.query(
    `UPDATE approval_requests SET status = $2, decided_by = $3, decided_at = now(),
            decision_note = $4, updated_by = $3 WHERE id = $1`,
    [approvalId, status, ctx.userId, note ?? null],
  );
  await ctx.audit({
    action: `approval_request.${status}`,
    entityType: 'approval_requests',
    entityId: approvalId,
    before: { status: 'pending' },
    after: { status },
  });
}
