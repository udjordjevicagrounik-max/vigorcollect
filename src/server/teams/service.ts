import { z } from 'zod';
import { ConflictError, NotFoundError, type TenantContext } from '@/server/auth/with-tenant';
import { emitEvent } from '@/server/events';

/**
 * Teams (task 1.6). Viewing needs `user.read`, managing `user.update` (the matrix has no
 * team.* keys; a new key needs Uroš's approval and a catalog migration — BACKLOG). One primary
 * team per person (DB unique index); the lead must be a member; lead changes write audit + a
 * domain event. Teams are archived, never deleted.
 */

export type Team = {
  id: string;
  key: string;
  name: string;
  status: string;
  leadUserId: string | null;
  members: { userId: string; displayName: string }[];
};

export const newTeamSchema = z.object({
  name: z.string().trim().min(1).max(120),
  key: z
    .string()
    .regex(/^[a-z][a-z0-9_-]{1,62}$/)
    .optional(),
});
export const memberSchema = z.object({ userId: z.uuid() });
export const leadSchema = z.object({ userId: z.uuid().nullable() });

function slug(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
  return /^[a-z]/.test(base) ? base : `t-${base || 'team'}`;
}

export async function listTeams(ctx: TenantContext): Promise<Team[]> {
  await ctx.requirePermission('user.read');
  const { rows } = await ctx.db.query<{
    id: string;
    key: string;
    name: string;
    status: string;
    lead_user_id: string | null;
    members: { userId: string; displayName: string }[] | null;
  }>(
    `SELECT t.id, t.key, t.name, t.status, t.lead_user_id,
            (SELECT json_agg(json_build_object('userId', u.id, 'displayName', u.display_name)
                             ORDER BY lower(u.display_name))
             FROM team_members tm JOIN users u ON u.id = tm.user_id WHERE tm.team_id = t.id) AS members
     FROM teams t ORDER BY t.status, lower(t.name)`,
  );
  return rows.map((r) => ({
    id: r.id,
    key: r.key,
    name: r.name,
    status: r.status,
    leadUserId: r.lead_user_id,
    members: r.members ?? [],
  }));
}

async function lockTeam(ctx: TenantContext, teamId: string) {
  const { rows } = await ctx.db.query<{ status: string; lead_user_id: string | null }>(
    'SELECT status, lead_user_id FROM teams WHERE id = $1 FOR UPDATE',
    [teamId],
  );
  const team = rows[0];
  if (!team) throw new NotFoundError();
  if (team.status !== 'active') throw new ConflictError('conflict');
  return team;
}

export async function createTeam(
  ctx: TenantContext,
  input: z.input<typeof newTeamSchema>,
): Promise<{ id: string }> {
  await ctx.requirePermission('user.update');
  const data = newTeamSchema.parse(input);
  const key = data.key ?? slug(data.name);
  const exists = await ctx.db.query('SELECT 1 FROM teams WHERE key = $1', [key]);
  if (exists.rowCount) throw new ConflictError('conflict');
  const { rows } = await ctx.db.query<{ id: string }>(
    `INSERT INTO teams (tenant_id, key, name, created_by) VALUES (app_tenant_id(), $1, $2, $3)
     RETURNING id`,
    [key, data.name, ctx.userId],
  );
  const id = rows[0]?.id ?? '';
  await ctx.audit({
    action: 'team.created',
    entityType: 'teams',
    entityId: id,
    after: { key, status: 'active' },
  });
  await emitEvent(ctx.db, {
    eventType: 'team.created',
    aggregateType: 'teams',
    aggregateId: id,
    requestId: ctx.requestId,
    actorId: ctx.userId,
  });
  return { id };
}

export async function addTeamMember(
  ctx: TenantContext,
  teamId: string,
  input: z.input<typeof memberSchema>,
) {
  await ctx.requirePermission('user.update');
  const { userId } = memberSchema.parse(input);
  await lockTeam(ctx, teamId);
  const user = await ctx.db.query<{ status: string }>('SELECT status FROM users WHERE id = $1', [
    userId,
  ]);
  if (!user.rows[0]) throw new NotFoundError();
  if (user.rows[0].status !== 'active') throw new ConflictError('conflict');
  const other = await ctx.db.query(
    `SELECT 1 FROM team_members WHERE user_id = $1 AND kind = 'primary'`,
    [userId],
  );
  if (other.rowCount) throw new ConflictError('conflict'); // one primary team (MVP)
  await ctx.db.query(
    `INSERT INTO team_members (tenant_id, team_id, user_id, created_by) VALUES (app_tenant_id(), $1, $2, $3)`,
    [teamId, userId, ctx.userId],
  );
  await ctx.audit({
    action: 'team_member.added',
    entityType: 'team_members',
    entityId: teamId,
    after: { team_id: teamId, user_id: userId },
  });
  await emitEvent(ctx.db, {
    eventType: 'team_member.added',
    aggregateType: 'teams',
    aggregateId: teamId,
    payload: { user_id: userId },
    requestId: ctx.requestId,
    actorId: ctx.userId,
  });
}

async function writeLead(
  ctx: TenantContext,
  teamId: string,
  before: string | null,
  after: string | null,
) {
  await ctx.db.query('UPDATE teams SET lead_user_id = $2, updated_by = $3 WHERE id = $1', [
    teamId,
    after,
    ctx.userId,
  ]);
  await ctx.audit({
    action: 'team.lead_changed',
    entityType: 'teams',
    entityId: teamId,
    before: { lead_user_id: before },
    after: { lead_user_id: after },
  });
  await emitEvent(ctx.db, {
    eventType: 'team.lead_changed',
    aggregateType: 'teams',
    aggregateId: teamId,
    payload: { lead_user_id: after },
    requestId: ctx.requestId,
    actorId: ctx.userId,
  });
}

export async function removeTeamMember(
  ctx: TenantContext,
  teamId: string,
  input: z.input<typeof memberSchema>,
) {
  await ctx.requirePermission('user.update');
  const { userId } = memberSchema.parse(input);
  const team = await lockTeam(ctx, teamId);
  const removed = await ctx.db.query(
    'DELETE FROM team_members WHERE team_id = $1 AND user_id = $2',
    [teamId, userId],
  );
  if (!removed.rowCount) throw new NotFoundError();
  if (team.lead_user_id === userId) await writeLead(ctx, teamId, userId, null);
  await ctx.audit({
    action: 'team_member.removed',
    entityType: 'team_members',
    entityId: teamId,
    before: { team_id: teamId, user_id: userId },
  });
}

/** Lead = a member of the team, or nobody. */
export async function setTeamLead(
  ctx: TenantContext,
  teamId: string,
  input: z.input<typeof leadSchema>,
) {
  await ctx.requirePermission('user.update');
  const { userId } = leadSchema.parse(input);
  const team = await lockTeam(ctx, teamId);
  if (userId) {
    const member = await ctx.db.query(
      'SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2',
      [teamId, userId],
    );
    if (!member.rowCount) throw new ConflictError('conflict');
  }
  if (team.lead_user_id === userId) return;
  await writeLead(ctx, teamId, team.lead_user_id, userId);
}
