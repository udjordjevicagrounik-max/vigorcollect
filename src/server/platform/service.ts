import { randomBytes, createHash } from 'node:crypto';
import { z } from 'zod';
import { issueInvitation } from '@/server/auth/invitations';
import { PermissionDeniedError } from '@/server/auth/permissions';
import { ConflictError, NotFoundError, type TenantContext } from '@/server/auth/with-tenant';
import type { MasterKeyring } from '@/server/crypto/keyring';
import type { Queryable } from '@/server/crypto/subject-keys';

/**
 * Platform → Tenants (6.4). Only in the platform operator tenant (#0) and only with
 * platform.manage. Cross-tenant work goes through SECURITY DEFINER functions of migration 030
 * that return NO business data (rule 32): name, slug, lifecycle, number of users, last activity.
 * Every platform action is audited under tenant #0 (ADR 0002).
 */

export async function requirePlatform(ctx: TenantContext): Promise<void> {
  await ctx.requirePermission('platform.manage');
  const { rows } = await ctx.db.query<{ op: boolean }>(
    'SELECT is_platform_operator AS op FROM tenants',
  );
  if (!rows[0]?.op) throw new PermissionDeniedError();
}

export type PlatformTenant = {
  id: string;
  slug: string;
  name: string;
  lifecycle: 'sandbox' | 'trial' | 'active' | 'suspended';
  isDemo: boolean;
  trialEndsAt: string | null;
  sandboxExpiresAt: string | null;
  contractSignedAt: string | null;
  createdAt: string;
  users: number;
  lastActivity: string | null;
};

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export async function listTenants(ctx: TenantContext): Promise<PlatformTenant[]> {
  await requirePlatform(ctx);
  const { rows } = await ctx.db.query<{
    id: string;
    slug: string;
    display_name: string;
    lifecycle_status: PlatformTenant['lifecycle'];
    is_demo: boolean;
    trial_ends_at: Date | null;
    sandbox_expires_at: Date | null;
    contract_signed_at: Date | null;
    created_at: Date;
    users: number;
    last_activity: Date | null;
  }>('SELECT * FROM platform_tenants()');
  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    name: r.display_name,
    lifecycle: r.lifecycle_status,
    isDemo: r.is_demo,
    trialEndsAt: iso(r.trial_ends_at),
    sandboxExpiresAt: iso(r.sandbox_expires_at),
    contractSignedAt: iso(r.contract_signed_at),
    createdAt: r.created_at.toISOString(),
    users: r.users,
    lastActivity: iso(r.last_activity),
  }));
}

export const newTenantSchema = z.object({
  name: z.string().trim().min(2).max(120),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/),
  country: z.string().regex(/^[A-Z]{2}$/),
  locale: z.enum(['sr-Latn', 'en']),
  timezone: z.string().min(1).max(60),
  currency: z.string().regex(/^[A-Z]{3}$/),
  policy: z.enum(['friendly', 'standard', 'strict']).default('standard'),
  lifecycle: z.enum(['trial', 'active', 'sandbox']).default('trial'),
  trialDays: z.int().min(1).max(90).default(14),
  isDemo: z.boolean().default(false),
  companyName: z.string().trim().min(2).max(200),
  companyTaxId: z.string().trim().min(2).max(40),
  owner: z.object({
    email: z.email().max(254),
    displayName: z.string().trim().min(1).max(200),
  }),
});

const TIMEZONES = new Set(Intl.supportedValuesOf('timeZone').concat('UTC'));

/**
 * Creates the tenant (030 function) and invites its first owner IN that tenant; the platform
 * transaction then returns to tenant #0 for the audit entry.
 */
export async function createTenant(
  ctx: TenantContext,
  input: z.input<typeof newTenantSchema>,
  deps: { keyring: MasterKeyring; baseURL: string },
): Promise<{ id: string }> {
  await requirePlatform(ctx);
  const d = newTenantSchema.parse(input);
  if (!TIMEZONES.has(d.timezone)) throw new ConflictError('invalid_request');
  if (d.lifecycle === 'sandbox' && !d.isDemo) throw new ConflictError('invalid_request');
  let id: string;
  try {
    await ctx.db.query('SAVEPOINT platform_create');
    const { rows } = await ctx.db.query<{ id: string }>(
      `SELECT platform_create_tenant($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) AS id`,
      [
        d.slug,
        d.name,
        d.country,
        d.locale,
        d.timezone,
        d.currency,
        d.policy,
        d.lifecycle,
        d.trialDays,
        d.isDemo,
        d.companyName,
        d.companyTaxId,
      ],
    );
    await ctx.db.query('RELEASE SAVEPOINT platform_create');
    id = rows[0]?.id ?? '';
  } catch (error) {
    await ctx.db.query('ROLLBACK TO SAVEPOINT platform_create');
    if ((error as { code?: string }).code === '23505') throw new ConflictError('conflict');
    throw error;
  }
  await inviteOwner(ctx, id, d.owner, deps);
  await ctx.audit({
    action: 'platform.tenant_created',
    entityType: 'tenants',
    entityId: id,
    after: { slug: d.slug, lifecycle: d.lifecycle, is_demo: d.isDemo, trial_days: d.trialDays },
  });
  return { id };
}

/** The first owner of a tenant, issued in THAT tenant (its mail rules apply: sink for trials). */
export async function inviteOwner(
  ctx: Pick<TenantContext, 'db' | 'tenantId' | 'userId' | 'requestId' | 'audit'>,
  tenantId: string,
  owner: { email: string; displayName: string },
  deps: { keyring: MasterKeyring; baseURL: string },
): Promise<void> {
  const back = ctx.tenantId;
  await ctx.db.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
  try {
    const { rows: t } = await ctx.db.query<{
      id: string;
      display_name: string;
      default_locale: string;
      timezone: string;
    }>(
      `SELECT t.id, t.display_name, s.default_locale, s.timezone FROM tenants t
       JOIN tenant_settings s ON s.tenant_id = t.id`,
    );
    const tenant = t[0];
    if (!tenant) throw new NotFoundError();
    const { rows } = await ctx.db.query<{ id: string; locale: string }>(
      `INSERT INTO users (tenant_id, email, display_name, locale, timezone, status)
       VALUES ($1, $2, $3, $4, $5, 'invited')
       ON CONFLICT (tenant_id, email) DO UPDATE SET display_name = users.display_name
       RETURNING id, locale`,
      [tenant.id, owner.email, owner.displayName, tenant.default_locale, tenant.timezone],
    );
    const user = rows[0];
    if (!user) throw new NotFoundError();
    // The platform's disabled service member of the tenant invites (migration 030).
    const inviter = await ctx.db.query<{ id: string }>(
      `SELECT id FROM users WHERE email = 'platform-operator@collect.invalid' AND status = 'disabled'`,
    );
    const inviterId = inviter.rows[0]?.id;
    if (!inviterId) throw new NotFoundError();
    // Audit of the invitation lands in the new tenant (its own history starts with it).
    await issueInvitation(
      {
        db: ctx.db,
        userId: inviterId,
        requestId: ctx.requestId,
        audit: (entry) => ctx.audit(entry),
      },
      { keyring: deps.keyring, baseURL: deps.baseURL },
      { tenant, user: { id: user.id, locale: user.locale, email: owner.email }, roleKey: 'owner' },
    );
  } finally {
    await ctx.db.query("SELECT set_config('app.tenant_id', $1, true)", [back]);
  }
}

export const lifecycleSchema = z.object({
  status: z.enum(['trial', 'active', 'suspended']).optional(),
  trialDays: z.int().min(1).max(90).optional(),
  contractSigned: z.boolean().optional(),
});

/** Convert a sandbox to a trial (14 days, is_demo off), activate, suspend, contract signed. */
export async function setLifecycle(
  ctx: TenantContext,
  tenantId: string,
  input: z.input<typeof lifecycleSchema>,
): Promise<{ ok: true }> {
  await requirePlatform(ctx);
  const d = lifecycleSchema.parse(input);
  try {
    await ctx.db.query('SAVEPOINT platform_lifecycle');
    await ctx.db.query('SELECT platform_set_lifecycle($1, $2, $3, $4)', [
      tenantId,
      d.status ?? null,
      d.trialDays ?? 14,
      d.contractSigned ?? false,
    ]);
    await ctx.db.query('RELEASE SAVEPOINT platform_lifecycle');
  } catch (error) {
    await ctx.db.query('ROLLBACK TO SAVEPOINT platform_lifecycle');
    if ((error as { code?: string }).code === 'P0002') throw new NotFoundError();
    throw error;
  }
  if (d.status === 'trial') {
    // A converted sandbox keeps its lead (signup request).
    await ctx.db.query(
      `UPDATE signup_requests SET status = 'converted', converted_tenant_id = $1 WHERE sandbox_tenant_id = $1`,
      [tenantId],
    );
  }
  await ctx.audit({
    action: 'platform.tenant_lifecycle',
    entityType: 'tenants',
    entityId: tenantId,
    after: { status: d.status ?? null, contract_signed: d.contractSigned ?? false },
  });
  return { ok: true };
}

export async function tenantFlags(ctx: TenantContext, tenantId: string) {
  await requirePlatform(ctx);
  const { rows } = await ctx.db.query<{
    flag_key: string;
    platform_enabled: boolean;
    enabled: boolean;
  }>('SELECT * FROM platform_tenant_flags($1)', [tenantId]);
  return rows.map((r) => ({
    key: r.flag_key,
    platformEnabled: r.platform_enabled,
    enabled: r.enabled,
  }));
}

export const flagSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/),
  enabled: z.boolean(),
});

export async function setFlag(
  ctx: TenantContext,
  tenantId: string,
  input: z.input<typeof flagSchema>,
) {
  await requirePlatform(ctx);
  const d = flagSchema.parse(input);
  try {
    await ctx.db.query('SAVEPOINT platform_flag');
    await ctx.db.query('SELECT platform_set_flag($1, $2, $3, $4)', [
      tenantId,
      d.key,
      d.enabled,
      ctx.userId,
    ]);
    await ctx.db.query('RELEASE SAVEPOINT platform_flag');
  } catch (error) {
    await ctx.db.query('ROLLBACK TO SAVEPOINT platform_flag');
    // Rule 31: a tenant flag cannot be on while the platform flag is off.
    if ((error as { code?: string }).code === '23514') throw new ConflictError('conflict');
    throw error;
  }
  await ctx.audit({
    action: 'platform.flag_set',
    entityType: 'tenants',
    entityId: tenantId,
    after: { flag: d.key, enabled: d.enabled },
  });
  return { ok: true as const };
}

// ---------------------------------------------------------------------------------------------
// Implementation tracker (tenant #0)
// ---------------------------------------------------------------------------------------------

export const TRACKER_STEPS = [
  'data_received',
  'import_done',
  'mailbox_done',
  'bank_done',
  'rules_done',
  'training_done',
  'go_live',
] as const;
export type TrackerStep = (typeof TRACKER_STEPS)[number];
export const SLA_HOURS = 72;

export type Tracker = {
  leadUserId: string | null;
  steps: Record<TrackerStep, string | null>;
  /** Hours since the data arrived (null before), and whether the 3-day SLA is broken. */
  hoursSinceData: number | null;
  slaBreached: boolean;
};

export async function getTracker(
  ctx: TenantContext,
  tenantId: string,
  now = new Date(),
): Promise<Tracker> {
  await requirePlatform(ctx);
  const { rows } = await ctx.db.query<Record<string, Date | string | null>>(
    `SELECT lead_user_id, data_received_at, import_done_at, mailbox_done_at, bank_done_at, rules_done_at,
            training_done_at, go_live_at FROM implementation_trackers WHERE target_tenant_id = $1`,
    [tenantId],
  );
  const r = rows[0] ?? {};
  const col = (s: TrackerStep) => (s === 'go_live' ? 'go_live_at' : `${s}_at`);
  const steps = Object.fromEntries(
    TRACKER_STEPS.map((s) => [
      s,
      r[col(s)] instanceof Date ? (r[col(s)] as Date).toISOString() : null,
    ]),
  ) as Tracker['steps'];
  const data = r.data_received_at instanceof Date ? r.data_received_at : null;
  const hours = data ? Math.floor((now.getTime() - data.getTime()) / 3_600_000) : null;
  return {
    leadUserId: (r.lead_user_id as string | null) ?? null,
    steps,
    hoursSinceData: hours,
    slaBreached: hours !== null && hours > SLA_HOURS && !steps.go_live,
  };
}

export const trackerUpdateSchema = z.object({
  step: z.enum(TRACKER_STEPS).optional(),
  done: z.boolean().optional(),
  leadUserId: z.uuid().nullable().optional(),
});

const STEP_SQL: Record<TrackerStep, string> = {
  data_received: `UPDATE implementation_trackers SET data_received_at = CASE WHEN $2 THEN coalesce(data_received_at, now()) END, updated_by = $3 WHERE target_tenant_id = $1`,
  import_done: `UPDATE implementation_trackers SET import_done_at = CASE WHEN $2 THEN coalesce(import_done_at, now()) END, updated_by = $3 WHERE target_tenant_id = $1`,
  mailbox_done: `UPDATE implementation_trackers SET mailbox_done_at = CASE WHEN $2 THEN coalesce(mailbox_done_at, now()) END, updated_by = $3 WHERE target_tenant_id = $1`,
  bank_done: `UPDATE implementation_trackers SET bank_done_at = CASE WHEN $2 THEN coalesce(bank_done_at, now()) END, updated_by = $3 WHERE target_tenant_id = $1`,
  rules_done: `UPDATE implementation_trackers SET rules_done_at = CASE WHEN $2 THEN coalesce(rules_done_at, now()) END, updated_by = $3 WHERE target_tenant_id = $1`,
  training_done: `UPDATE implementation_trackers SET training_done_at = CASE WHEN $2 THEN coalesce(training_done_at, now()) END, updated_by = $3 WHERE target_tenant_id = $1`,
  go_live: `UPDATE implementation_trackers SET go_live_at = CASE WHEN $2 THEN coalesce(go_live_at, now()) END, updated_by = $3 WHERE target_tenant_id = $1`,
};

export async function updateTracker(
  ctx: TenantContext,
  tenantId: string,
  input: z.input<typeof trackerUpdateSchema>,
): Promise<{ ok: true }> {
  await requirePlatform(ctx);
  const d = trackerUpdateSchema.parse(input);
  await ctx.db.query(
    `INSERT INTO implementation_trackers (tenant_id, target_tenant_id, created_by, updated_by)
     VALUES (app_tenant_id(), $1, $2, $2) ON CONFLICT (tenant_id, target_tenant_id) DO NOTHING`,
    [tenantId, ctx.userId],
  );
  if (d.step) await ctx.db.query(STEP_SQL[d.step], [tenantId, d.done ?? true, ctx.userId]);
  if (d.leadUserId !== undefined)
    await ctx.db.query(
      'UPDATE implementation_trackers SET lead_user_id = $2, updated_by = $3 WHERE target_tenant_id = $1',
      [tenantId, d.leadUserId, ctx.userId],
    );
  await ctx.audit({
    action: 'platform.tracker_updated',
    entityType: 'implementation_trackers',
    entityId: tenantId,
    after: { step: d.step ?? null, done: d.done ?? null },
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// Onboarding data package (client tenant; public page /onboarding/<token>)
// ---------------------------------------------------------------------------------------------

export const PACKAGE_HOURS = 72;
export const hashPackageToken = (token: string) =>
  createHash('sha256').update(token, 'utf8').digest();

/** A new package link for a client tenant — the token is shown ONCE (only its hash is stored). */
export async function createPackage(
  ctx: TenantContext,
  tenantId: string,
  baseURL: string,
): Promise<{ url: string; expiresAt: string }> {
  await requirePlatform(ctx);
  const token = randomBytes(32).toString('base64url');
  const back = ctx.tenantId;
  await ctx.db.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
  let expires: Date;
  try {
    const { rows } = await ctx.db.query<{ expires_at: Date }>(
      `INSERT INTO onboarding_packages (tenant_id, token_hash, created_by) VALUES (app_tenant_id(), $1, $2)
       RETURNING expires_at`,
      [hashPackageToken(token), ctx.userId],
    );
    expires = rows[0]?.expires_at ?? new Date();
  } finally {
    await ctx.db.query("SELECT set_config('app.tenant_id', $1, true)", [back]);
  }
  await ctx.audit({
    action: 'platform.package_created',
    entityType: 'tenants',
    entityId: tenantId,
    after: { hours: PACKAGE_HOURS },
  });
  return {
    url: `${baseURL.replace(/\/$/, '')}/onboarding/${token}`,
    expiresAt: expires.toISOString(),
  };
}

export type PackageInfo = {
  id: string;
  tenantId: string;
  tenantName: string;
  expiresAt: string;
  receivedAt: string | null;
  files: number;
  answered: boolean;
};

/** Public lookup (no session): a valid, unexpired package or null. */
export async function lookupPackage(db: Queryable, token: string): Promise<PackageInfo | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const { rows } = await db.query<{
    id: string;
    tenant_id: string;
    tenant_name: string;
    expires_at: Date;
    received_at: Date | null;
    files: number;
    answered: boolean;
  }>('SELECT * FROM onboarding_package_lookup($1)', [hashPackageToken(token)]);
  const r = rows[0];
  if (!r || r.expires_at.getTime() < Date.now()) return null;
  return {
    id: r.id,
    tenantId: r.tenant_id,
    tenantName: r.tenant_name,
    expiresAt: r.expires_at.toISOString(),
    receivedAt: iso(r.received_at),
    files: r.files,
    answered: r.answered,
  };
}
