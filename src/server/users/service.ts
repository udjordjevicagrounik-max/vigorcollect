import { z } from 'zod';
import { mayInvite } from '@/server/auth/invitations';
import { PermissionDeniedError } from '@/server/auth/permissions';
import { ConflictError, NotFoundError, type TenantContext } from '@/server/auth/with-tenant';
import { emitEvent } from '@/server/events';
import { isPrivilegedRole, secondAdminRequired } from '@/server/governance/four-eyes';

/**
 * Tenant members (task 1.5). Every function runs inside withTenant() / withTenantPage() — RLS
 * keeps it inside the tenant; ids of another tenant simply do not exist (404).
 *
 * Roles: owner may give any role, admin any but owner (same rule as invitations). A change that
 * touches a PRIVILEGED role — owner, admin, cfo, collection_manager (review S-06; before: only
 * owner/admin) — to or from, is NOT applied: it becomes an approval_request (decision after
 * 0.2a/0.2b, rule 11) that another person with `user.assign` (checker-only in the matrix)
 * decides — the database enforces requester ≠ decider. Bootstrap: a tenant with exactly one
 * active administrator applies it directly (nobody else could approve). Other role changes
 * apply directly (`user.update`) and keep the member's scope (widening scope is `user.assign`).
 */

export const ROLE_CHANGE_ACTION = 'user_role.change';

export type Member = {
  id: string;
  displayName: string;
  email: string;
  status: 'invited' | 'active' | 'disabled';
  roles: { key: string; scope: string }[];
  invitation: { id: string; roleKey: string; expired: boolean } | null;
  pendingRoleChange: { approvalId: string; roleKey: string; requestedByMe: boolean } | null;
};

async function actorRoles(ctx: TenantContext): Promise<string[]> {
  const { rows } = await ctx.db.query<{ key: string }>(
    `SELECT r.key FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1`,
    [ctx.userId],
  );
  return rows.map((r) => r.key);
}

/** Roles the current member may hand out (invitation, role change). */
export async function assignableRoles(ctx: TenantContext): Promise<string[]> {
  const mine = await actorRoles(ctx);
  const { rows } = await ctx.db.query<{ key: string }>('SELECT key FROM roles ORDER BY key');
  return rows.map((r) => r.key).filter((key) => mayInvite(mine, key));
}

export async function listMembers(ctx: TenantContext): Promise<Member[]> {
  const { scope } = await ctx.requirePermission('user.read');
  const { rows } = await ctx.db.query<{
    id: string;
    display_name: string;
    email: string;
    status: Member['status'];
    roles: { key: string; scope: string }[] | null;
    invitation_id: string | null;
    invitation_role: string | null;
    invitation_expired: boolean | null;
    approval_id: string | null;
    approval_role: string | null;
    approval_requested_by: string | null;
  }>(
    `SELECT u.id, u.display_name, u.email::text AS email, u.status,
            (SELECT json_agg(json_build_object('key', r.key, 'scope', ur.scope) ORDER BY r.key)
             FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id) AS roles,
            i.id AS invitation_id, i.role_key AS invitation_role,
            i.expires_at <= now() AS invitation_expired,
            a.id AS approval_id, a.payload->>'role_key' AS approval_role,
            a.requested_by AS approval_requested_by
     FROM users u
     LEFT JOIN user_invitations i ON i.user_id = u.id AND i.status = 'pending'
     LEFT JOIN approval_requests a ON a.entity_type = 'users' AND a.entity_id = u.id
                                  AND a.action_type = $2 AND a.status = 'pending'
     WHERE ($1::uuid IS NULL OR u.id = $1)
     ORDER BY u.status = 'disabled', lower(u.display_name), u.id`,
    [scope === 'ORGANIZATION' ? null : ctx.userId, ROLE_CHANGE_ACTION],
  );
  return rows.map((r) => ({
    id: r.id,
    displayName: r.display_name,
    email: r.email,
    status: r.status,
    roles: r.roles ?? [],
    invitation: r.invitation_id
      ? {
          id: r.invitation_id,
          roleKey: r.invitation_role ?? '',
          expired: Boolean(r.invitation_expired),
        }
      : null,
    pendingRoleChange:
      r.approval_id && r.approval_role
        ? {
            approvalId: r.approval_id,
            roleKey: r.approval_role,
            requestedByMe: r.approval_requested_by === ctx.userId,
          }
        : null,
  }));
}

async function lockMember(ctx: TenantContext, userId: string) {
  const { rows } = await ctx.db.query<{ status: Member['status']; roles: string[] | null }>(
    `SELECT u.status,
            (SELECT array_agg(r.key) FROM user_roles ur JOIN roles r ON r.id = ur.role_id
             WHERE ur.user_id = u.id) AS roles
     FROM users u WHERE u.id = $1 FOR UPDATE`,
    [userId],
  );
  const row = rows[0];
  if (!row) throw new NotFoundError();
  return { status: row.status, roles: row.roles ?? [] };
}

async function activeOwners(ctx: TenantContext): Promise<number> {
  const { rows } = await ctx.db.query<{ n: number }>(
    `SELECT count(DISTINCT u.id)::int AS n FROM users u
     JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
     WHERE r.key = 'owner' AND u.status = 'active'`,
  );
  return rows[0]?.n ?? 0;
}

/** Deactivation is a status, never a DELETE. The person keeps their identity; access ends. */
export async function deactivateMember(ctx: TenantContext, userId: string): Promise<void> {
  await ctx.requirePermission('user.update');
  if (userId === ctx.userId) throw new ConflictError('self_action');
  const target = await lockMember(ctx, userId);
  const mine = await actorRoles(ctx);
  if (!target.roles.every((role) => mayInvite(mine, role))) throw new PermissionDeniedError();
  if (target.status === 'disabled') throw new ConflictError('conflict');
  if (
    target.roles.includes('owner') &&
    target.status === 'active' &&
    (await activeOwners(ctx)) <= 1
  ) {
    throw new ConflictError('last_owner');
  }
  await ctx.db.query(`UPDATE users SET status = 'disabled', updated_by = $2 WHERE id = $1`, [
    userId,
    ctx.userId,
  ]);
  const revoked = await ctx.db.query<{ id: string }>(
    `UPDATE user_invitations SET status = 'revoked', updated_by = $2
     WHERE user_id = $1 AND status = 'pending' RETURNING id`,
    [userId, ctx.userId],
  );
  await ctx.audit({
    action: 'user.deactivated',
    entityType: 'users',
    entityId: userId,
    before: { status: target.status },
    after: { status: 'disabled' },
  });
  for (const r of revoked.rows) {
    await ctx.audit({
      action: 'user_invitation.revoked',
      entityType: 'user_invitations',
      entityId: r.id,
      before: { status: 'pending' },
      after: { status: 'revoked', reason: 'user_deactivated' },
    });
  }
  await emitEvent(ctx.db, {
    eventType: 'user.deactivated',
    aggregateType: 'users',
    aggregateId: userId,
    requestId: ctx.requestId,
    actorId: ctx.userId,
  });
}

async function applyRole(ctx: TenantContext, userId: string, roleKey: string): Promise<void> {
  const { rows: before } = await ctx.db.query<{ role_id: string; scope: string }>(
    'SELECT role_id, scope FROM user_roles WHERE user_id = $1 ORDER BY role_id',
    [userId],
  );
  // Keep the member's widest existing scope — a role change never widens it.
  const rank: Record<string, number> = { OWN: 1, TEAM: 2, ORGANIZATION: 3 };
  const scope = before.reduce(
    (best, r) => ((rank[r.scope] ?? 0) > (rank[best] ?? 0) ? r.scope : best),
    'OWN',
  );
  await ctx.db.query('DELETE FROM user_roles WHERE user_id = $1', [userId]);
  const { rows: after } = await ctx.db.query<{ role_id: string }>(
    `INSERT INTO user_roles (tenant_id, user_id, role_id, scope, created_by)
     SELECT app_tenant_id(), $1, r.id, $3, $4 FROM roles r WHERE r.key = $2 RETURNING role_id`,
    [userId, roleKey, scope, ctx.userId],
  );
  await ctx.audit({
    action: 'user_role.changed',
    entityType: 'user_roles',
    entityId: userId,
    before: { user_id: userId, role_id: before.map((r) => r.role_id).join(','), scope },
    after: { user_id: userId, role_id: after[0]?.role_id ?? null, scope },
  });
  await emitEvent(ctx.db, {
    eventType: 'user_role.changed',
    aggregateType: 'users',
    aggregateId: userId,
    payload: { role_key: roleKey },
    requestId: ctx.requestId,
    actorId: ctx.userId,
  });
}

export const roleChangeSchema = z.object({ roleKey: z.string().regex(/^[a-z][a-z0-9_]{1,62}$/) });

export type RoleChangeResult =
  { status: 'applied' } | { status: 'approval_required'; approvalId: string };

export async function changeMemberRole(
  ctx: TenantContext,
  userId: string,
  input: z.input<typeof roleChangeSchema>,
): Promise<RoleChangeResult> {
  await ctx.requirePermission('user.update');
  const { roleKey } = roleChangeSchema.parse(input);
  if (userId === ctx.userId) throw new ConflictError('self_action');
  const target = await lockMember(ctx, userId);
  if (target.status !== 'active') throw new ConflictError('conflict');
  const role = await ctx.db.query('SELECT 1 FROM roles WHERE key = $1', [roleKey]);
  if (!role.rowCount) throw new ConflictError('unknown_role');
  const mine = await actorRoles(ctx);
  if (!mayInvite(mine, roleKey) || !target.roles.every((r) => mayInvite(mine, r))) {
    throw new PermissionDeniedError();
  }
  if (target.roles.length === 1 && target.roles[0] === roleKey) throw new ConflictError('conflict');
  if (target.roles.includes('owner') && roleKey !== 'owner' && (await activeOwners(ctx)) <= 1) {
    throw new ConflictError('last_owner');
  }

  const privileged = isPrivilegedRole(roleKey) || target.roles.some(isPrivilegedRole);
  if (!privileged || !(await secondAdminRequired(ctx.db))) {
    await applyRole(ctx, userId, roleKey);
    return { status: 'applied' };
  }

  // Four eyes (rule 11, review S-06): privileged role changes wait for another administrator.
  const pending = await ctx.db.query(
    `SELECT 1 FROM approval_requests WHERE action_type = $1 AND entity_type = 'users'
       AND entity_id = $2 AND status = 'pending'`,
    [ROLE_CHANGE_ACTION, userId],
  );
  if (pending.rowCount) throw new ConflictError('conflict');
  const { rows } = await ctx.db.query<{ id: string }>(
    `INSERT INTO approval_requests (tenant_id, action_type, entity_type, entity_id, payload,
                                    requested_by, request_id, created_by)
     VALUES (app_tenant_id(), $1, 'users', $2, jsonb_build_object('user_id', $2::uuid, 'role_key', $3::text),
             $4, $5, $4) RETURNING id`,
    [ROLE_CHANGE_ACTION, userId, roleKey, ctx.userId, ctx.requestId],
  );
  const approvalId = rows[0]?.id ?? '';
  await ctx.audit({
    action: 'approval_request.created',
    entityType: 'approval_requests',
    entityId: approvalId,
    after: {
      action_type: ROLE_CHANGE_ACTION,
      entity_type: 'users',
      entity_id: userId,
      status: 'pending',
    },
  });
  await emitEvent(ctx.db, {
    eventType: 'approval_request.created',
    aggregateType: 'approval_requests',
    aggregateId: approvalId,
    payload: { action_type: ROLE_CHANGE_ACTION },
    requestId: ctx.requestId,
    actorId: ctx.userId,
  });
  return { status: 'approval_required', approvalId };
}

export const decisionSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  note: z.string().trim().min(1).max(500).optional(),
});

/** Checker side of a role change (user.assign = checker-only in the matrix). */
export async function decideRoleChange(
  ctx: TenantContext,
  approvalId: string,
  input: z.input<typeof decisionSchema>,
): Promise<{ status: 'approved' | 'rejected' }> {
  await ctx.requirePermission('user.assign');
  const { decision, note } = decisionSchema.parse(input);
  const { rows } = await ctx.db.query<{
    action_type: string;
    status: string;
    requested_by: string;
    user_id: string | null;
    role_key: string | null;
  }>(
    `SELECT action_type, status, requested_by, payload->>'user_id' AS user_id,
            payload->>'role_key' AS role_key
     FROM approval_requests WHERE id = $1 FOR UPDATE`,
    [approvalId],
  );
  const request = rows[0];
  if (!request) throw new NotFoundError();
  if (request.action_type !== ROLE_CHANGE_ACTION) throw new ConflictError('unsupported');
  if (request.status !== 'pending') throw new ConflictError('not_pending');
  // The database enforces four eyes too (approval_requests_four_eyes); this keeps the answer clean.
  if (request.requested_by === ctx.userId) throw new PermissionDeniedError();
  if (!request.user_id || !request.role_key) throw new ConflictError('conflict');
  const target = await lockMember(ctx, request.user_id);
  const mine = await actorRoles(ctx);
  if (!mayInvite(mine, request.role_key) || !target.roles.every((r) => mayInvite(mine, r))) {
    throw new PermissionDeniedError();
  }

  const status = decision === 'approve' ? 'approved' : 'rejected';
  await ctx.db.query(
    `UPDATE approval_requests SET status = $2, decided_by = $3, decided_at = now(),
            decision_note = $4, updated_by = $3
     WHERE id = $1`,
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
    if (target.status !== 'active') throw new ConflictError('conflict');
    await applyRole(ctx, request.user_id, request.role_key);
  }
  return { status };
}
