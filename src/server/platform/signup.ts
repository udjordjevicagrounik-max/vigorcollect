import { createHmac, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { demoCsv } from '../../../scripts/demo-import/generate';
import { logEvent } from '@/lib/log';
import { writeAudit, type AuditEntry } from '@/server/auth/audit';
import type { MasterKeyring } from '@/server/crypto/keyring';
import { emitEvent } from '@/server/events';
import { parseCsv } from '@/server/imports/csv';
import { sealGrid } from '@/server/imports/crypto';
import { applyImport } from '@/server/imports/process';
import { detectColumns, detectDateOrder, detectDecimal, type Mapping } from '@/server/imports/rows';
import { seal } from '@/server/integrations/crypto';
import { inviteOwner } from './service';

/**
 * Public signup → sandbox (6.4, rule 27). POST /api/public/signup: Turnstile, honeypot, rate limit
 * per IP and per e-mail, the SAME answer whatever happens (no account enumeration). A sandbox is a
 * demo tenant (is_demo — sink only, rule 24) with generated demo data (the demo import file, rule
 * 24), 7 days, then read-only 7 days, then deleted by the platform job. The lead's data is sealed
 * in tenant #0 (signup_requests); operators get an attention item; a Pipedrive lead goes through
 * n8n only when the platform flag signup.pipedrive_lead is on (event payload: ids only).
 */

export const signupSchema = z.object({
  company: z.string().trim().min(2).max(200),
  name: z.string().trim().min(2).max(200),
  email: z.email().max(254),
  country: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .default('RS'),
  locale: z.enum(['sr-Latn', 'en']).default('sr-Latn'),
  /** Honeypot: humans never see it, so it must stay empty. */
  website: z.string().max(200).optional(),
  captchaToken: z.string().max(4000).optional(),
});
export type SignupInput = z.input<typeof signupSchema>;

export const SANDBOX_DAYS = 7;
export const SIGNUP_LIMITS = {
  ip: { windowSeconds: 3600, max: 5 },
  email: { windowSeconds: 86_400, max: 3 },
} as const;

/** Rate limit key of an e-mail: HMAC (never the address itself in the limiter table). */
export function emailLimitKey(keyring: MasterKeyring, email: string): string {
  const key = Buffer.from(hkdfSync('sha256', keyring.current.key, 'platform', 'signup_limit', 32));
  return `signup:email:${createHmac('sha256', key).update(email.trim().toLowerCase()).digest('base64url')}`;
}

async function hit(
  db: Pool | PoolClient,
  key: string,
  limit: { windowSeconds: number; max: number },
) {
  const { rows } = await db.query<{ allowed: boolean }>(
    'SELECT allowed FROM api_rate_limit_hit($1, $2, $3)',
    [key, limit.windowSeconds, limit.max],
  );
  return rows[0]?.allowed ?? true;
}

export type SignupDeps = {
  keyring: MasterKeyring;
  baseURL: string;
  ip: string | undefined;
  verifyCaptcha: (token: string | undefined) => Promise<boolean>;
  now?: Date;
};

export type SignupOutcome = 'created' | 'ignored';

/** One transaction: sandbox tenant + owner invitation + demo data + lead (tenant #0). */
export async function signup(
  pool: Pool,
  input: SignupInput,
  deps: SignupDeps,
): Promise<SignupOutcome> {
  const client = await pool.connect();
  try {
    // Captcha, honeypot and the rate limits first, OUTSIDE the transaction: a refused attempt
    // still counts against its IP and e-mail.
    if (!(await admissible(client, input, deps))) return 'ignored';
    await client.query('BEGIN');
    const outcome = await signupWith(client, input, deps, { checked: true });
    await client.query(outcome === 'created' ? 'COMMIT' : 'ROLLBACK');
    return outcome;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    // The answer stays the same (rule 27); the reason goes to the log without personal data.
    logEvent('platform.signup_failed', {
      level: 'error',
      name: error instanceof Error ? error.name : 'unknown',
      code: (error as { code?: string }).code ?? null,
    });
    return 'ignored';
  } finally {
    client.release();
  }
}

async function admissible(
  client: PoolClient,
  input: SignupInput,
  deps: SignupDeps,
): Promise<boolean> {
  const parsed = signupSchema.safeParse(input);
  if (!parsed.success) return false;
  const d = parsed.data;
  if (d.website) return false; // honeypot filled → a bot; the same answer as success
  if (!(await deps.verifyCaptcha(d.captchaToken))) return false;
  if (deps.ip && !(await hit(client, `signup:ip:${deps.ip}`, SIGNUP_LIMITS.ip))) return false;
  return hit(client, emailLimitKey(deps.keyring, d.email), SIGNUP_LIMITS.email);
}

/** The signup inside the caller's transaction (tests run it in a rolled-back one). */
export async function signupWith(
  client: PoolClient,
  input: SignupInput,
  deps: SignupDeps,
  opts: { checked?: boolean } = {},
): Promise<SignupOutcome> {
  if (!opts.checked && !(await admissible(client, input, deps))) return 'ignored';
  const d = signupSchema.parse(input);

  const { rows: opRows } = await client.query<{ op: string | null }>(
    'SELECT platform_operator_id() AS op',
  );
  const op = opRows[0]?.op;
  if (!op) throw new Error('no platform operator');
  await client.query("SELECT set_config('app.tenant_id', $1, true)", [op]);
  const profile = await client.query<{ currency: string; timezone: string }>(
    `SELECT default_currency AS currency, default_timezone AS timezone FROM jurisdiction_profiles
     WHERE country_code = $1`,
    [d.country],
  );
  const p = profile.rows[0] ?? { currency: 'EUR', timezone: 'UTC' };
  const slug = `sbx-${randomBytes(5).toString('hex')}`;
  const { rows } = await client.query<{ id: string }>(
    `SELECT platform_create_tenant($1, $2, $3, $4, $5, $6, 'standard', 'sandbox', $7, true, $2, $8) AS id`,
    [
      slug,
      d.company.slice(0, 120),
      d.country,
      d.locale,
      p.timezone,
      p.currency,
      SANDBOX_DAYS,
      'SANDBOX-DEMO',
    ],
  );
  const tenantId = rows[0]?.id ?? '';
  const requestId = randomUUID();
  const systemAudit = (entry: AuditEntry) =>
    writeAudit(client, { type: 'system', id: null }, entry, requestId);
  const ctx = {
    db: client,
    tenantId: op,
    userId: null as unknown as string,
    requestId,
    audit: systemAudit,
  };
  await inviteOwner(ctx, tenantId, { email: d.email, displayName: d.name }, deps);
  await seedSandbox(client, deps.keyring, tenantId, p.currency, deps.now ?? new Date());

  // The lead in tenant #0, sealed; operators see it in "Needs attention".
  await client.query("SELECT set_config('app.tenant_id', $1, true)", [op]);
  const id = randomUUID();
  const s = (
    target: 'signup_requests.company' | 'signup_requests.name' | 'signup_requests.email',
    v: string,
  ) => seal(deps.keyring, op, target, id, v);
  const company = s('signup_requests.company', d.company);
  const name = s('signup_requests.name', d.name);
  const email = s('signup_requests.email', d.email.toLowerCase());
  await client.query(
    `INSERT INTO signup_requests (id, tenant_id, sandbox_tenant_id, company_enc, company_key_version, name_enc,
                                  name_key_version, email_enc, email_key_version, country_code, locale)
     VALUES ($1, app_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      id,
      tenantId,
      company.ciphertext,
      company.keyVersion,
      name.ciphertext,
      name.keyVersion,
      email.ciphertext,
      email.keyVersion,
      d.country,
      d.locale,
    ],
  );
  await client.query(
    `INSERT INTO notifications (tenant_id, user_id, message_key)
     SELECT app_tenant_id(), ur.user_id, 'signup_received' FROM user_roles ur
     JOIN role_permissions rp ON rp.role_id = ur.role_id JOIN permissions pm ON pm.id = rp.permission_id
     WHERE pm.key = 'platform.manage' GROUP BY ur.user_id`,
  );
  await systemAudit({
    action: 'platform.signup_sandbox',
    entityType: 'tenants',
    entityId: tenantId,
    after: { lifecycle: 'sandbox', country: d.country, days: SANDBOX_DAYS },
  });
  const flag = await client.query<{ on: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM platform_feature_flags p JOIN feature_flags f ON f.flag_key = p.key
                    WHERE p.key = 'signup.pipedrive_lead' AND p.enabled AND f.enabled) AS on`,
  );
  if (flag.rows[0]?.on) {
    await emitEvent(client, {
      eventType: 'signup.created',
      aggregateType: 'signup_requests',
      aggregateId: id,
      payload: { signup_id: id, country: d.country, locale: d.locale },
      requestId,
    });
  }
  logEvent('platform.signup', { tenantId: op, sandboxTenantId: tenantId });
  return 'created';
}

/** Demo data of a sandbox: the generated demo invoice file through the normal import (rule 24). */
export async function seedSandbox(
  db: PoolClient,
  keyring: MasterKeyring,
  tenantId: string,
  currency: string,
  today: Date,
): Promise<void> {
  await db.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
  const grid = parseCsv(demoCsv(today, currency), 20_000);
  const header = grid[0] ?? [];
  const columns = detectColumns(header);
  const mapping: Mapping = {
    columns,
    decimal: detectDecimal(grid, columns),
    dateOrder: detectDateOrder(grid, columns),
  };
  const { rows: refs } = await db.query<{ source: string; company: string; owner: string }>(
    `SELECT (SELECT id FROM data_sources WHERE name = 'file-import') AS source,
            (SELECT id FROM tenant_companies ORDER BY is_default DESC LIMIT 1) AS company,
            (SELECT id FROM users ORDER BY created_at LIMIT 1) AS owner`,
  );
  const r = refs[0];
  if (!r?.source || !r.company || !r.owner) return;
  const id = randomUUID();
  const sealed = sealGrid(keyring, tenantId, id, grid);
  await db.query(
    `INSERT INTO import_runs (id, tenant_id, source_id, company_id, file_format, file_sha256, payload_enc,
                              payload_key_version, mapping, rows_total, status, confirmed_at, confirmed_by, created_by)
     VALUES ($1, app_tenant_id(), $2, $3, 'csv', digest($4, 'sha256'), $5, $6, $7, $8, 'confirmed', now(), $9, $9)`,
    [
      id,
      r.source,
      r.company,
      header.join(','),
      sealed.ciphertext,
      sealed.keyVersion,
      mapping,
      grid.length - 1,
      r.owner,
    ],
  );
  await applyImport(
    db,
    (e) => writeAudit(db, { type: 'system', id: null }, e, null),
    keyring,
    tenantId,
    id,
  );
}
