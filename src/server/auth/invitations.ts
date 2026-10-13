import { createHash, randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import type { MasterKeyring } from '@/server/crypto/keyring';
import type { Queryable } from '@/server/crypto/subject-keys';
import {
  closeApproval,
  INVITE_ACTION,
  isPrivilegedRole,
  lockApproval,
  openApproval,
  secondAdminRequired,
} from '@/server/governance/four-eyes';
import { sendMail, type MailOptions } from '@/server/mail/adapter';
import { writeAudit } from './audit';
import type { Auth } from './better-auth';
import { PermissionDeniedError } from './permissions';
import { ConflictError, type TenantContext } from './with-tenant';

/**
 * One-time invitations (ADR 0004, task 1.1b; migration 006).
 *
 * - The token is 32 random bytes (base64url). It exists in plaintext ONLY in the e-mail
 *   (mail_outbox, encrypted); the table stores its SHA-256. It is never returned, logged or
 *   written to audit.
 * - Valid 72 h, single use — enforced by the service AND by the user_invitations_final trigger.
 * - Owner may invite any role; admin any role except owner; nobody else (decision after 1.1b).
 *   The route additionally requires `user.create` (1.2). The role's scope is OWN — widening it
 *   is `user.assign` (maker-checker, 1.4).
 * - Review S-06: inviting someone into a PRIVILEGED role (owner, admin, cfo, collection_manager)
 *   needs a second administrator — the invited row is created, but no token / e-mail exists
 *   until another person with `user.assign` approves (approval_requests 'user.invite'). The
 *   bootstrap tenant with exactly one active administrator invites directly.
 * - Accepting creates (or, for a person already signed in, reuses) the Better Auth identity,
 *   links it to the invited public.users row, assigns the role and writes the audit row — in
 *   one tenant transaction. The tenant comes from the invitation row found by the token hash,
 *   never from request input.
 */

export const INVITATION_TTL_HOURS = 72;

export class InvitationError extends Error {
  override name = 'InvitationError';
  constructor(
    readonly code:
      | 'forbidden_role'
      | 'unknown_role'
      | 'already_member'
      | 'user_disabled'
      | 'invalid'
      | 'expired'
      | 'sign_in_required'
      | 'wrong_account'
      | 'weak_password',
  ) {
    super(code);
  }
}

export function hashInviteToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

export const newInvitationSchema = z.object({
  email: z.email().max(254),
  displayName: z.string().trim().min(1).max(200),
  roleKey: z.string().regex(/^[a-z][a-z0-9_]{1,62}$/),
  locale: z.enum(['sr-Latn', 'en']).optional(),
});

export type NewInvitation = z.input<typeof newInvitationSchema>;

/** The part of the withTenant() context invitation management needs. */
export type InvitationContext = Pick<TenantContext, 'db' | 'userId' | 'audit' | 'requestId'>;

export type InvitationDeps = { keyring: MasterKeyring; baseURL: string; mail?: MailOptions };

/** Invitation issued (token + e-mail), or a privileged one waiting for a second administrator. */
export type InvitationResult =
  | { status: 'sent'; invitationId: string; userId: string }
  | { status: 'approval_required'; approvalId: string; userId: string };

async function actorRoleKeys(db: Queryable, userId: string): Promise<string[]> {
  const { rows } = await db.query<{ key: string }>(
    `SELECT r.key FROM user_roles ur JOIN roles r ON r.tenant_id = ur.tenant_id AND r.id = ur.role_id
     WHERE ur.user_id = $1`,
    [userId],
  );
  return rows.map((r) => r.key);
}

export function mayInvite(actorRoles: string[], roleKey: string): boolean {
  if (actorRoles.includes('owner')) return true;
  return actorRoles.includes('admin') && roleKey !== 'owner';
}

/**
 * Creates (or re-sends) an invitation in the CURRENT tenant transaction (withTenant). A pending
 * invitation of the same user is revoked: re-sending always issues a new token.
 */
export async function createInvitation(
  ctx: InvitationContext,
  deps: InvitationDeps,
  input: NewInvitation,
): Promise<InvitationResult> {
  const { db } = ctx;
  const data = newInvitationSchema.parse(input);
  if (!mayInvite(await actorRoleKeys(db, ctx.userId), data.roleKey)) {
    throw new InvitationError('forbidden_role');
  }
  const role = await db.query('SELECT 1 FROM roles WHERE key = $1', [data.roleKey]);
  if (!role.rowCount) throw new InvitationError('unknown_role');

  const { rows: tenantRows } = await db.query<{
    id: string;
    display_name: string;
    default_locale: string;
    timezone: string;
  }>(
    `SELECT t.id, t.display_name, s.default_locale, s.timezone
     FROM tenants t JOIN tenant_settings s ON s.tenant_id = t.id`,
  );
  const tenant = tenantRows[0];
  if (!tenant) throw new InvitationError('invalid');

  const existing = await db.query<{ id: string; status: string; locale: string }>(
    'SELECT id, status, locale FROM users WHERE email = $1',
    [data.email],
  );
  let user = existing.rows[0];
  if (user?.status === 'active') throw new InvitationError('already_member');
  if (user?.status === 'disabled') throw new InvitationError('user_disabled');
  if (!user) {
    const inserted = await db.query<{ id: string; status: string; locale: string }>(
      `INSERT INTO users (tenant_id, email, display_name, locale, timezone, status, created_by)
       VALUES ($1, $2, $3, $4, $5, 'invited', $6) RETURNING id, status, locale`,
      [
        tenant.id,
        data.email,
        data.displayName,
        data.locale ?? tenant.default_locale,
        tenant.timezone,
        ctx.userId,
      ],
    );
    user = inserted.rows[0];
    if (!user) throw new InvitationError('invalid');
    await ctx.audit({
      action: 'user.created',
      entityType: 'users',
      entityId: user.id,
      after: { status: 'invited', locale: user.locale },
    });
  }

  await revokePending(ctx, user.id, 'resent');
  if (isPrivilegedRole(data.roleKey) && (await secondAdminRequired(db))) {
    const approvalId = await openApproval(ctx, {
      actionType: INVITE_ACTION,
      entityType: 'users',
      entityId: user.id,
      payload: { user_id: user.id, role_key: data.roleKey },
    });
    return { status: 'approval_required', approvalId, userId: user.id };
  }
  const invitationId = await issueInvitation(ctx, deps, {
    tenant,
    user: { id: user.id, locale: user.locale, email: data.email },
    roleKey: data.roleKey,
  });
  return { status: 'sent', invitationId, userId: user.id };
}

async function revokePending(ctx: InvitationContext, userId: string, reason: string) {
  const revoked = await ctx.db.query<{ id: string }>(
    `UPDATE user_invitations SET status = 'revoked', updated_by = $2
     WHERE user_id = $1 AND status = 'pending' RETURNING id`,
    [userId, ctx.userId],
  );
  for (const r of revoked.rows) {
    await ctx.audit({
      action: 'user_invitation.revoked',
      entityType: 'user_invitations',
      entityId: r.id,
      before: { status: 'pending' },
      after: { status: 'revoked', reason },
    });
  }
}

/** Token (hash stored) + e-mail with the link: the invitation the invitee can accept. */
async function issueInvitation(
  ctx: InvitationContext,
  deps: InvitationDeps,
  target: {
    tenant: { id: string; display_name: string };
    user: { id: string; locale: string; email: string };
    roleKey: string;
  },
): Promise<string> {
  const { tenant, user, roleKey } = target;
  const token = randomBytes(32).toString('base64url');
  const { rows } = await ctx.db.query<{ id: string }>(
    `INSERT INTO user_invitations (tenant_id, user_id, role_key, token_hash, invited_by,
                                   expires_at, created_by)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(hours => $6), $5)
     RETURNING id`,
    [tenant.id, user.id, roleKey, hashInviteToken(token), ctx.userId, INVITATION_TTL_HOURS],
  );
  const invitationId = rows[0]?.id;
  if (!invitationId) throw new InvitationError('invalid');

  // audit() keeps only P0 columns of user_invitations — never the e-mail, name or token.
  await ctx.audit({
    action: 'user_invitation.created',
    entityType: 'user_invitations',
    entityId: invitationId,
    after: { user_id: user.id, role_key: roleKey, status: 'pending' },
  });

  await sendMail(
    ctx.db,
    deps.keyring,
    {
      kind: 'invitation',
      to: user.email,
      locale: user.locale,
      tenantName: tenant.display_name,
      url: `${deps.baseURL.replace(/\/$/, '')}/invite/${token}`,
    },
    deps.mail,
  );
  return invitationId;
}

export const invitationDecisionSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  note: z.string().trim().min(1).max(500).optional(),
});

/**
 * Checker side of a privileged invitation (review S-06): another person with `user.assign` who
 * may hand out that role approves → the invitation is issued now (token + e-mail); rejected →
 * nothing is sent, the invited row stays without an invitation.
 */
export async function decideInvitation(
  ctx: TenantContext,
  deps: InvitationDeps,
  approvalId: string,
  input: z.input<typeof invitationDecisionSchema>,
): Promise<{ status: 'approved' | 'rejected' }> {
  const req = await lockApproval(ctx, approvalId, INVITE_ACTION);
  const { decision, note } = invitationDecisionSchema.parse(input);
  const roleKey = String(req.payload.role_key ?? '');
  if (!mayInvite(await actorRoleKeys(ctx.db, ctx.userId), roleKey)) {
    throw new PermissionDeniedError();
  }
  const status = decision === 'approve' ? 'approved' : 'rejected';
  await closeApproval(ctx, approvalId, status, note);
  if (status === 'rejected') return { status };

  const { rows } = await ctx.db.query<{
    id: string;
    status: string;
    locale: string;
    email: string;
    tenant_id: string;
    tenant_name: string;
  }>(
    `SELECT u.id, u.status, u.locale, u.email, t.id AS tenant_id, t.display_name AS tenant_name
     FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.id = $1 FOR UPDATE OF u`,
    [req.entityId],
  );
  const user = rows[0];
  if (!user || user.status !== 'invited') throw new ConflictError('conflict');
  await revokePending(ctx, user.id, 'approved_again');
  await issueInvitation(ctx, deps, {
    tenant: { id: user.tenant_id, display_name: user.tenant_name },
    user: { id: user.id, locale: user.locale, email: user.email },
    roleKey,
  });
  return { status };
}

// ---------------------------------------------------------------------------------------------
// Invitee side (no session, or a session of the invited person)
// ---------------------------------------------------------------------------------------------

type InvitationRow = {
  id: string;
  tenant_id: string;
  user_id: string;
  role_key: string;
  status: string;
  expired: boolean;
};

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/**
 * Opens a transaction in the invitation's tenant. The tenant is found through the token hash
 * (policy invite_token_lookup, pre-tenant only); app.invite_token_hash is cleared before
 * app.tenant_id is set. Returns null for an unknown token.
 */
async function inInvitationTenant<T>(
  pool: Pool,
  token: string,
  fn: (client: PoolClient, invitation: InvitationRow) => Promise<T>,
): Promise<T | null> {
  if (!TOKEN_SHAPE.test(token)) return null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.invite_token_hash', $1, true)", [
      hashInviteToken(token).toString('hex'),
    ]);
    const found = await client.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM user_invitations',
    );
    const tenantId = found.rows[0]?.tenant_id;
    await client.query("SELECT set_config('app.invite_token_hash', '', true)");
    if (!tenantId) {
      await client.query('ROLLBACK');
      return null;
    }
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const { rows } = await client.query<InvitationRow>(
      `SELECT id, tenant_id, user_id, role_key, status, expires_at <= now() AS expired
       FROM user_invitations WHERE token_hash = $1 FOR UPDATE`,
      [hashInviteToken(token)],
    );
    const invitation = rows[0];
    if (!invitation) {
      await client.query('ROLLBACK');
      return null;
    }
    const result = await fn(client, invitation);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export type InvitationPreview =
  | { status: 'invalid' }
  | { status: 'expired'; tenantName: string }
  | {
      status: 'valid';
      tenantName: string;
      email: string;
      displayName: string;
      roleKey: string;
      /** The person already has a sign-in identity → accept while signed in. */
      identityExists: boolean;
    };

/** What the /invite/[token] screen shows. Used, revoked and unknown tokens look the same. */
export async function previewInvitation(
  pool: Pool,
  auth: Auth,
  token: string,
): Promise<InvitationPreview> {
  const result = await inInvitationTenant(pool, token, async (client, inv) => {
    const { rows } = await client.query<{
      tenant_name: string;
      email: string;
      display_name: string;
    }>(
      `SELECT t.display_name AS tenant_name, u.email, u.display_name
       FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.id = $1`,
      [inv.user_id],
    );
    const row = rows[0];
    if (!row || inv.status !== 'pending') return { status: 'invalid' } as const;
    if (inv.expired) return { status: 'expired', tenantName: row.tenant_name } as const;
    const ctx = await auth.$context;
    const identity = await ctx.internalAdapter.findUserByEmail(row.email);
    return {
      status: 'valid',
      tenantName: row.tenant_name,
      email: row.email,
      displayName: row.display_name,
      roleKey: inv.role_key,
      identityExists: Boolean(identity),
    } as const;
  });
  return result ?? { status: 'invalid' };
}

export type AcceptInput =
  /** New person: sets the password of the new identity. */
  | { mode: 'new'; password: string }
  /** Person who already has an identity: id from a VERIFIED Better Auth session only. */
  | { mode: 'existing'; authUserId: string };

/**
 * Accepts an invitation. Returns the tenant and users row it was bound to. The identity is
 * created through Better Auth (internalAdapter + its password hasher); if anything after that
 * fails, the transaction rolls back and the new identity is removed again.
 */
export async function acceptInvitation(
  pool: Pool,
  auth: Auth,
  token: string,
  input: AcceptInput,
): Promise<{ tenantId: string; userId: string; authUserId: string }> {
  const ctx = await auth.$context;
  let createdIdentity: string | undefined;
  try {
    const result = await inInvitationTenant(pool, token, async (client, inv) => {
      if (inv.status !== 'pending') throw new InvitationError('invalid');
      if (inv.expired) throw new InvitationError('expired');
      const { rows } = await client.query<{ email: string; display_name: string; status: string }>(
        'SELECT email, display_name, status FROM users WHERE id = $1 FOR UPDATE',
        [inv.user_id],
      );
      const user = rows[0];
      if (!user || user.status !== 'invited') throw new InvitationError('invalid');

      const identity = await ctx.internalAdapter.findUserByEmail(user.email);
      let authUserId: string;
      if (input.mode === 'existing') {
        if (!identity) throw new InvitationError('invalid');
        if (identity.user.id !== input.authUserId) throw new InvitationError('wrong_account');
        authUserId = identity.user.id;
      } else {
        if (identity) throw new InvitationError('sign_in_required');
        const { minPasswordLength, maxPasswordLength } = ctx.password.config;
        if (
          input.password.length < minPasswordLength ||
          input.password.length > maxPasswordLength
        ) {
          throw new InvitationError('weak_password');
        }
        const created = await ctx.internalAdapter.createUser(
          { email: user.email, name: user.display_name, emailVerified: true },
          { method: 'admin' },
        );
        createdIdentity = created.id;
        await ctx.internalAdapter.linkAccount({
          userId: created.id,
          providerId: 'credential',
          accountId: created.id,
          password: await ctx.password.hash(input.password),
        });
        authUserId = created.id;
      }

      await client.query(
        `UPDATE users SET auth_user_id = $2, status = 'active', updated_by = $1 WHERE id = $1`,
        [inv.user_id, authUserId],
      );
      await client.query(
        `INSERT INTO user_roles (tenant_id, user_id, role_id, scope, created_by)
         SELECT $1, $2, r.id, 'OWN', $2 FROM roles r WHERE r.key = $3
         ON CONFLICT (tenant_id, user_id, role_id) DO NOTHING`,
        [inv.tenant_id, inv.user_id, inv.role_key],
      );
      await client.query(
        `UPDATE user_invitations SET status = 'accepted', used_at = now(), updated_by = $2
         WHERE id = $1`,
        [inv.id, inv.user_id],
      );
      const actor = { type: 'user', id: inv.user_id } as const;
      await writeAudit(
        client,
        actor,
        {
          action: 'user_invitation.accepted',
          entityType: 'user_invitations',
          entityId: inv.id,
          before: { status: 'pending' },
          after: { status: 'accepted', user_id: inv.user_id, role_key: inv.role_key },
        },
        null,
      );
      await writeAudit(
        client,
        actor,
        {
          action: 'user.activated',
          entityType: 'users',
          entityId: inv.user_id,
          before: { status: 'invited' },
          after: { status: 'active' },
        },
        null,
      );
      await writeAudit(
        client,
        actor,
        {
          action: 'user_role.assigned',
          entityType: 'user_roles',
          entityId: inv.user_id,
          after: { user_id: inv.user_id, scope: 'OWN' },
        },
        null,
      );
      return { tenantId: inv.tenant_id, userId: inv.user_id, authUserId };
    });
    if (!result) throw new InvitationError('invalid');
    return result;
  } catch (error) {
    if (createdIdentity)
      await ctx.internalAdapter.deleteUser(createdIdentity).catch(() => undefined);
    throw error;
  }
}
