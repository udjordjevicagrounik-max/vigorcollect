import type { Pool } from 'pg';
import { z } from 'zod';
import { logEvent } from '@/lib/log';
import { listAttention } from '@/server/attention/service';
import { PermissionDeniedError } from '@/server/auth/permissions';
import { scopeFilter } from '@/server/auth/scope';
import { createTenantContext, type TenantContext } from '@/server/auth/with-tenant';
import { getMasterKeyring, type MasterKeyring } from '@/server/crypto/keyring';
import { localMoment } from '@/server/jobs/schedule';
import { withTenantJob, type TenantJobContext } from '@/server/jobs/tenant-job';
import { sendDigestMail, type DigestContent } from '@/server/mail/adapter';
import { getDashboard } from '@/server/receivables/service';

/**
 * Digests (5.2). Daily "My day" at 07:00 in the MEMBER's time zone (users.timezone, rule 26): my
 * attention items, promises due today, tasks, new mail — only what my scope shows. Weekly manager
 * digest on Monday 07:00 for members holding report.read: overdue, collected (30 d), broken
 * promises, top 5 customers of their scope. Through mail_outbox (a demo tenant only the sink —
 * rule 24); digest_runs (member + kind + LOCAL date) makes every tick idempotent. Nothing to
 * report → no mail (outcome 'empty'). Preferences per member decide which digests and which
 * in-app lists they get.
 */

export const DIGEST_LOCAL_TIME_MIN = 7 * 60;

export const preferencesSchema = z.object({
  dailyDigest: z.boolean(),
  weeklyDigest: z.boolean(),
  inAppAttention: z.boolean(),
  inAppMail: z.boolean(),
});
export type Preferences = z.infer<typeof preferencesSchema>;

const DEFAULTS: Preferences = {
  dailyDigest: true,
  weeklyDigest: true,
  inAppAttention: true,
  inAppMail: true,
};

export async function getPreferences(
  ctx: Pick<TenantContext, 'db' | 'userId'>,
): Promise<Preferences> {
  const { rows } = await ctx.db.query<{
    daily_digest: boolean;
    weekly_digest: boolean;
    in_app_attention: boolean;
    in_app_mail: boolean;
  }>(
    `SELECT daily_digest, weekly_digest, in_app_attention, in_app_mail
     FROM notification_preferences WHERE user_id = $1`,
    [ctx.userId],
  );
  const r = rows[0];
  return r
    ? {
        dailyDigest: r.daily_digest,
        weeklyDigest: r.weekly_digest,
        inAppAttention: r.in_app_attention,
        inAppMail: r.in_app_mail,
      }
    : DEFAULTS;
}

/** A member sets only their own preferences. */
export async function savePreferences(
  ctx: TenantContext,
  input: z.input<typeof preferencesSchema>,
): Promise<Preferences> {
  const p = preferencesSchema.parse(input);
  const before = await getPreferences(ctx);
  await ctx.db.query(
    `INSERT INTO notification_preferences (tenant_id, user_id, daily_digest, weekly_digest, in_app_attention, in_app_mail)
     VALUES (app_tenant_id(), $1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id, user_id) DO UPDATE SET daily_digest = $2, weekly_digest = $3,
       in_app_attention = $4, in_app_mail = $5`,
    [ctx.userId, p.dailyDigest, p.weeklyDigest, p.inAppAttention, p.inAppMail],
  );
  await ctx.audit({
    action: 'notification_preferences.saved',
    entityType: 'notification_preferences',
    entityId: ctx.userId,
    before,
    after: p,
  });
  return p;
}

const held = async (ctx: TenantContext, key: string) => {
  try {
    return await ctx.requirePermission(key);
  } catch (error) {
    if (error instanceof PermissionDeniedError) return null;
    throw error;
  }
};

/** "My day" of a member — counts and a few names, only within their scope. */
export async function dailyContent(ctx: TenantContext): Promise<DigestContent | null> {
  const customers = await held(ctx, 'customer.read');
  if (!customers) return null;
  const attention = await listAttention(ctx, 20);
  const me = { userId: ctx.userId, scope: customers.scope };
  const f = scopeFilter('customers', me, 'c', 1);
  const promises = await ctx.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM promises pr JOIN customers c ON c.id = pr.customer_id
     JOIN tenant_companies tc ON tc.id = pr.company_id
     JOIN legal_entities_public le ON le.id = tc.legal_entity_id
     WHERE pr.status = 'pending' AND pr.promised_on <= (now() AT TIME ZONE le.timezone)::date AND ${f.sql}`,
    f.params,
  );
  const mail = await ctx.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM mail_inbox m JOIN customers c ON c.id = m.customer_id
     WHERE m.status = 'new' AND NOT m.is_bounce AND ${f.sql}`,
    f.params,
  );
  const tasks = attention.filter((a) => a.kind === 'task_due').length;
  const content: DigestContent = {
    kind: 'daily',
    attention: attention.filter((a) => a.kind !== 'task_due').length,
    promisesDue: promises.rows[0]?.n ?? 0,
    tasks,
    newMail: mail.rows[0]?.n ?? 0,
    top: attention
      .filter((a) => a.customerName)
      .slice(0, 5)
      .map((a) => a.customerName ?? ''),
  };
  const empty = !content.attention && !content.promisesDue && !content.tasks && !content.newMail;
  return empty ? null : content;
}

/** Weekly manager digest — only with report.read; figures of the member's scope. */
export async function weeklyContent(ctx: TenantContext): Promise<DigestContent | null> {
  if (!(await held(ctx, 'report.read')) || !(await held(ctx, 'customer.read'))) return null;
  const d = await getDashboard(ctx);
  if (d.aging.every((a) => a.count === 0) && d.collected30 === '0.00') return null;
  return {
    kind: 'weekly',
    currency: d.currency,
    overdue: d.overdueTotal,
    collected30: d.collected30,
    promisesBroken: d.promisesBroken,
    top: d.topOverdue.slice(0, 5).map((c) => c.displayName ?? '—'),
  };
}

type Due = {
  userId: string;
  email: string;
  locale: string;
  kind: 'daily' | 'weekly';
  localDate: string;
};

/** Members of the current tenant whose digest is due at `now` and not yet done for that date. */
async function dueDigests(job: TenantJobContext, now: Date): Promise<Due[]> {
  const { rows } = await job.db.query<{
    id: string;
    email: string;
    locale: string;
    timezone: string;
    daily: boolean;
    weekly: boolean;
  }>(
    `SELECT u.id, u.email::text, u.locale, u.timezone,
            coalesce(p.daily_digest, true) AS daily, coalesce(p.weekly_digest, true) AS weekly
     FROM users u LEFT JOIN notification_preferences p ON p.user_id = u.id
     WHERE u.status = 'active'`,
  );
  const due: Due[] = [];
  for (const u of rows) {
    let local;
    try {
      local = localMoment(u.timezone, now);
    } catch {
      local = localMoment('UTC', now);
    }
    if (local.minutes < DIGEST_LOCAL_TIME_MIN) continue;
    const monday = new Date(`${local.date}T00:00:00Z`).getUTCDay() === 1;
    for (const kind of ['daily', 'weekly'] as const) {
      if (kind === 'daily' ? !u.daily : !u.weekly || !monday) continue;
      const done = await job.db.query(
        'SELECT 1 FROM digest_runs WHERE user_id = $1 AND kind = $2 AND local_date = $3::date',
        [u.id, kind, local.date],
      );
      if (!done.rowCount)
        due.push({ userId: u.id, email: u.email, locale: u.locale, kind, localDate: local.date });
    }
  }
  return due;
}

/** One tenant: every due digest, each in a SAVEPOINT (one member's failure never blocks others). */
export async function runTenantDigests(
  job: TenantJobContext,
  now: Date,
  keyring: MasterKeyring = getMasterKeyring(),
): Promise<{ sent: number; empty: number; failed: number }> {
  const out = { sent: 0, empty: 0, failed: 0 };
  for (const d of await dueDigests(job, now)) {
    await job.db.query('SAVEPOINT digest');
    try {
      const ctx = createTenantContext(job.db, {
        tenantId: job.tenantId,
        userId: d.userId,
        authUserId: 'job:digest',
        requestId: job.jobId,
      });
      const content = d.kind === 'daily' ? await dailyContent(ctx) : await weeklyContent(ctx);
      let mailId: string | null = null;
      if (content)
        mailId = (await sendDigestMail(job.db, keyring, { to: d.email, locale: d.locale, content }))
          .id;
      await job.db.query(
        `INSERT INTO digest_runs (tenant_id, user_id, kind, local_date, mail_outbox_id, outcome)
         VALUES (app_tenant_id(), $1, $2, $3::date, $4, $5)`,
        [d.userId, d.kind, d.localDate, mailId, mailId ? 'sent' : 'empty'],
      );
      await job.db.query('RELEASE SAVEPOINT digest');
      if (mailId) out.sent += 1;
      else out.empty += 1;
    } catch (error) {
      await job.db.query('ROLLBACK TO SAVEPOINT digest');
      out.failed += 1;
      logEvent('digest.failed', {
        level: 'warn',
        tenantId: job.tenantId,
        kind: d.kind,
        name: error instanceof Error ? error.name : 'unknown',
      });
    }
  }
  return out;
}

/** Worker tick (every 15 min): every tenant from tenant_clock(), one transaction per tenant. */
export async function digestTick(workerPool: Pool, appPool: Pool, now: Date, jobId: string) {
  const { rows } = await workerPool.query<{ tenant_id: string }>(
    'SELECT DISTINCT tenant_id FROM tenant_clock()',
  );
  for (const r of rows) {
    try {
      const counts = await withTenantJob(appPool, r.tenant_id, jobId, (job) =>
        runTenantDigests(job, now),
      );
      if (counts.sent || counts.failed)
        logEvent('digest.tick', { tenantId: r.tenant_id, ...counts });
    } catch (error) {
      logEvent('digest.tenant_failed', {
        level: 'error',
        tenantId: r.tenant_id,
        name: error instanceof Error ? error.name : 'unknown',
      });
    }
  }
}

/**
 * "Send me my digest now" (Account → Notifications): today's "My day" to the member's own
 * address through the same way out (a demo tenant only the sink — rule 24). Does not count as
 * the scheduled run (digest_runs untouched); with nothing to report the mail says so.
 */
export async function sendDigestNow(
  ctx: TenantContext,
  keyring: MasterKeyring = getMasterKeyring(),
): Promise<{ transport: string }> {
  const { rows } = await ctx.db.query<{ email: string; locale: string }>(
    `SELECT email::text, locale FROM users WHERE id = $1 AND status = 'active'`,
    [ctx.userId],
  );
  const me = rows[0];
  if (!me) throw new PermissionDeniedError();
  const content = (await dailyContent(ctx)) ?? {
    kind: 'daily' as const,
    attention: 0,
    promisesDue: 0,
    tasks: 0,
    newMail: 0,
    top: [],
  };
  const mail = await sendDigestMail(ctx.db, keyring, { to: me.email, locale: me.locale, content });
  await ctx.audit({
    action: 'digest.sent_on_request',
    entityType: 'mail_outbox',
    entityId: mail.id,
    after: { kind: 'daily', transport: mail.transport },
  });
  return { transport: mail.transport };
}
