import { z } from 'zod';
import { mayInvite } from '@/server/auth/invitations';
import { PermissionDeniedError, permissionKeys } from '@/server/auth/permissions';
import { ConflictError, NotFoundError, type TenantContext } from '@/server/auth/with-tenant';
import { emitEvent } from '@/server/events';
import { decideRoleChange, decisionSchema, ROLE_CHANGE_ACTION } from '@/server/users/service';

/**
 * Approvals (task 1.6; rule 11, decision after 0.2a/0.2b): changes of role grants per tenant are
 * approval_requests — the old matrix holds until a checker approves.
 *   - propose a grant change: `approval.create` (maker);
 *   - decide it: `role.manage` (checker-only 🅼 in the matrix); role changes: `user.assign`;
 *   - requester ≠ decider (service + DB constraint approval_requests_four_eyes).
 * The owner role's grants are not changeable here (it always holds everything; no lock-out).
 */

export const GRANT_CHANGE_ACTION = 'role_permission.change';
export const CHECKER: Record<string, string> = {
  [ROLE_CHANGE_ACTION]: 'user.assign',
  [GRANT_CHANGE_ACTION]: 'role.manage',
};
export const APPROVAL_VIEW_KEYS = [
  'approval.read',
  'role.manage',
  'user.assign',
  'approval.create',
] as const;

export type PendingApproval = {
  id: string;
  actionType: string;
  createdAt: string;
  requestedBy: { id: string; displayName: string };
  roleKey: string | null;
  permissionKey: string | null;
  grant: boolean | null;
  targetUser: { id: string; displayName: string } | null;
  canDecide: boolean;
  requestedByMe: boolean;
};

export async function listPendingApprovals(ctx: TenantContext): Promise<PendingApproval[]> {
  await ctx.requireAnyPermission(APPROVAL_VIEW_KEYS);
  const mine = await permissionKeys(ctx.db, ctx.userId);
  const { rows } = await ctx.db.query<{
    id: string;
    action_type: string;
    created_at: Date;
    requested_by: string;
    requester_name: string;
    role_key: string | null;
    permission_key: string | null;
    grant: boolean | null;
    target_id: string | null;
    target_name: string | null;
  }>(
    `SELECT a.id, a.action_type, a.created_at, a.requested_by, r.display_name AS requester_name,
            a.payload->>'role_key' AS role_key, a.payload->>'permission_key' AS permission_key,
            (a.payload->>'grant')::boolean AS grant,
            t.id AS target_id, t.display_name AS target_name
     FROM approval_requests a
     JOIN users r ON r.id = a.requested_by
     LEFT JOIN users t ON a.entity_type = 'users' AND t.id = a.entity_id
     WHERE a.status = 'pending' AND a.action_type = ANY($1::text[])
     ORDER BY a.created_at`,
    [Object.keys(CHECKER)],
  );
  return rows.map((r) => ({
    id: r.id,
    actionType: r.action_type,
    createdAt: r.created_at.toISOString(),
    requestedBy: { id: r.requested_by, displayName: r.requester_name },
    roleKey: r.role_key,
    permissionKey: r.permission_key,
    grant: r.grant,
    targetUser: r.target_id ? { id: r.target_id, displayName: r.target_name ?? '' } : null,
    canDecide: r.requested_by !== ctx.userId && mine.has(CHECKER[r.action_type] ?? ''),
    requestedByMe: r.requested_by === ctx.userId,
  }));
}

export const grantChangeSchema = z.object({
  roleKey: z.string().regex(/^[a-z][a-z0-9_]{1,62}$/),
  permissionKey: z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/),
  grant: z.boolean(),
});

export async function proposeGrantChange(
  ctx: TenantContext,
  input: z.input<typeof grantChangeSchema>,
): Promise<{ approvalId: string }> {
  await ctx.requirePermission('approval.create');
  const data = grantChangeSchema.parse(input);
  if (data.roleKey === 'owner') throw new ConflictError('unsupported');
  const { rows: found } = await ctx.db.query<{
    role_id: string | null;
    permission_id: string | null;
    granted: boolean;
  }>(
    `SELECT (SELECT id FROM roles WHERE key = $1) AS role_id,
            (SELECT id FROM permissions WHERE key = $2) AS permission_id,
            EXISTS (SELECT 1 FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
                    JOIN permissions p ON p.id = rp.permission_id
                    WHERE r.key = $1 AND p.key = $2) AS granted`,
    [data.roleKey, data.permissionKey],
  );
  const f = found[0];
  if (!f?.role_id) throw new ConflictError('unknown_role');
  if (!f.permission_id) throw new ConflictError('invalid_request');
  if (f.granted === data.grant) throw new ConflictError('conflict');
  const pending = await ctx.db.query(
    `SELECT 1 FROM approval_requests WHERE action_type = $1 AND status = 'pending'
       AND payload->>'role_key' = $2 AND payload->>'permission_key' = $3`,
    [GRANT_CHANGE_ACTION, data.roleKey, data.permissionKey],
  );
  if (pending.rowCount) throw new ConflictError('conflict');
  const { rows } = await ctx.db.query<{ id: string }>(
    `INSERT INTO approval_requests (tenant_id, action_type, entity_type, entity_id, payload,
                                    requested_by, request_id, created_by)
     VALUES (app_tenant_id(), $1, 'roles', $2,
             jsonb_build_object('role_key', $3::text, 'permission_key', $4::text, 'grant', $5::boolean),
             $6, $7, $6) RETURNING id`,
    [
      GRANT_CHANGE_ACTION,
      f.role_id,
      data.roleKey,
      data.permissionKey,
      data.grant,
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
      action_type: GRANT_CHANGE_ACTION,
      entity_type: 'roles',
      entity_id: f.role_id,
      status: 'pending',
    },
  });
  await emitEvent(ctx.db, {
    eventType: 'approval_request.created',
    aggregateType: 'approval_requests',
    aggregateId: approvalId,
    payload: { action_type: GRANT_CHANGE_ACTION },
    requestId: ctx.requestId,
    actorId: ctx.userId,
  });
  return { approvalId };
}

async function decideGrantChange(
  ctx: TenantContext,
  approvalId: string,
  input: z.input<typeof decisionSchema>,
): Promise<{ status: 'approved' | 'rejected' }> {
  await ctx.requirePermission('role.manage');
  const { decision, note } = decisionSchema.parse(input);
  const { rows } = await ctx.db.query<{
    status: string;
    requested_by: string;
    role_key: string;
    permission_key: string;
    grant: boolean;
  }>(
    `SELECT status, requested_by, payload->>'role_key' AS role_key,
            payload->>'permission_key' AS permission_key, (payload->>'grant')::boolean AS grant
     FROM approval_requests WHERE id = $1 FOR UPDATE`,
    [approvalId],
  );
  const req = rows[0];
  if (!req) throw new NotFoundError();
  if (req.status !== 'pending') throw new ConflictError('not_pending');
  if (req.requested_by === ctx.userId) throw new PermissionDeniedError();
  const myRoles = await ctx.db.query<{ key: string }>(
    `SELECT r.key FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1`,
    [ctx.userId],
  );
  if (
    !mayInvite(
      myRoles.rows.map((r) => r.key),
      req.role_key,
    )
  )
    throw new PermissionDeniedError();

  const status = decision === 'approve' ? 'approved' : 'rejected';
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
  if (status === 'approved') {
    const { rows: ids } = await ctx.db.query<{ role_id: string; permission_id: string }>(
      `SELECT r.id AS role_id, p.id AS permission_id FROM roles r, permissions p
       WHERE r.key = $1 AND p.key = $2`,
      [req.role_key, req.permission_key],
    );
    const ref = ids[0];
    if (!ref) throw new ConflictError('conflict');
    if (req.grant) {
      await ctx.db.query(
        `INSERT INTO role_permissions (tenant_id, role_id, permission_id, created_by)
         VALUES (app_tenant_id(), $1, $2, $3) ON CONFLICT DO NOTHING`,
        [ref.role_id, ref.permission_id, ctx.userId],
      );
    } else {
      await ctx.db.query('DELETE FROM role_permissions WHERE role_id = $1 AND permission_id = $2', [
        ref.role_id,
        ref.permission_id,
      ]);
    }
    await ctx.audit({
      action: req.grant ? 'role_permission.granted' : 'role_permission.revoked',
      entityType: 'role_permissions',
      entityId: ref.role_id,
      after: { role_id: ref.role_id, permission_id: ref.permission_id },
    });
    await emitEvent(ctx.db, {
      eventType: 'role_permission.changed',
      aggregateType: 'roles',
      aggregateId: ref.role_id,
      payload: { permission_id: ref.permission_id, grant: req.grant },
      requestId: ctx.requestId,
      actorId: ctx.userId,
    });
  }
  return { status };
}

/** Routes a checker's decision to the flow of the request's type. */
export async function decideApproval(
  ctx: TenantContext,
  approvalId: string,
  input: z.input<typeof decisionSchema>,
): Promise<{ status: 'approved' | 'rejected' }> {
  const { rows } = await ctx.db.query<{ action_type: string }>(
    'SELECT action_type FROM approval_requests WHERE id = $1',
    [approvalId],
  );
  const type = rows[0]?.action_type;
  if (!type) throw new NotFoundError();
  if (type === ROLE_CHANGE_ACTION) return decideRoleChange(ctx, approvalId, input);
  if (type === GRANT_CHANGE_ACTION) return decideGrantChange(ctx, approvalId, input);
  throw new ConflictError('unsupported');
}
