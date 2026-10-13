import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { logEvent } from '@/lib/log';
import { writeAudit } from '@/server/auth/audit';
import { ConflictError } from '@/server/auth/with-tenant';
import type { MasterKeyring } from '@/server/crypto/keyring';
import { stageImport } from '@/server/imports/service';
import { proposeTemplate, QUESTIONS, type Answers } from '@/server/library/policy-templates';
import { lookupPackage, type PackageInfo } from './service';

/**
 * The client's data package (6.4, public /onboarding/<token>, rule 27: 72 h token, Turnstile, rate
 * limit, no session). Files land in import_runs 'staged' in the client tenant (sealed, rule 9);
 * the 10 questions store codes and a proposed policy template — an administrator applies it.
 * The first file or answers = receipt: the operator's implementation SLA clock starts.
 */

export const MAX_FILES = 20;
export const PACKAGE_LIMIT = { windowSeconds: 3600, max: 30 } as const;

export const fileSchema = z.object({
  fileName: z.string().trim().min(1).max(200),
  format: z.enum(['csv', 'xlsx']),
  content: z.string().max(8_000_000),
  captchaToken: z.string().max(4000).optional(),
});

export const answersSchema = z.object({
  answers: z.object(
    Object.fromEntries(
      Object.entries(QUESTIONS).map(([k, v]) => [k, z.enum(v as unknown as [string, ...string[]])]),
    ) as Record<keyof typeof QUESTIONS, z.ZodEnum>,
  ),
  captchaToken: z.string().max(4000).optional(),
});

type Deps = {
  keyring: MasterKeyring;
  ip: string | undefined;
  verifyCaptcha: (t: string | undefined) => Promise<boolean>;
};

async function admitted(
  client: PoolClient,
  deps: Deps,
  token: string | undefined,
): Promise<boolean> {
  if (!(await deps.verifyCaptcha(token))) return false;
  if (!deps.ip) return true;
  const { rows } = await client.query<{ allowed: boolean }>(
    'SELECT allowed FROM api_rate_limit_hit($1, $2, $3)',
    [`onboarding:ip:${deps.ip}`, PACKAGE_LIMIT.windowSeconds, PACKAGE_LIMIT.max],
  );
  return rows[0]?.allowed ?? true;
}

async function inPackageTenant<T>(
  client: PoolClient,
  pkg: PackageInfo,
  fn: () => Promise<T>,
): Promise<T> {
  await client.query('BEGIN');
  try {
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [pkg.tenantId]);
    const out = await fn();
    await client.query('SELECT platform_mark_data_received($1)', [pkg.tenantId]);
    await client.query('COMMIT');
    return out;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

export type PackageOutcome =
  'ok' | 'invalid' | 'too_many_files' | 'file_too_large' | 'file_unreadable' | 'no_valid_rows';

export async function uploadPackageFile(
  pool: Pool,
  token: string,
  input: z.input<typeof fileSchema>,
  deps: Deps,
): Promise<PackageOutcome> {
  const parsed = fileSchema.safeParse(input);
  if (!parsed.success) return 'invalid';
  const client = await pool.connect();
  try {
    if (!(await admitted(client, deps, parsed.data.captchaToken))) return 'invalid';
    const pkg = await lookupPackage(client, token);
    if (!pkg) return 'invalid';
    if (pkg.files >= MAX_FILES) return 'too_many_files';
    return await inPackageTenant(client, pkg, async () => {
      const staged = await stageImport(client, deps.keyring, pkg.tenantId, parsed.data);
      await client.query(
        `UPDATE onboarding_packages SET files = files + 1, received_at = coalesce(received_at, now()) WHERE id = $1`,
        [pkg.id],
      );
      await writeAudit(
        client,
        { type: 'system', id: null },
        {
          action: 'onboarding.file_received',
          entityType: 'import_runs',
          entityId: staged.id,
          after: { rows: staged.rows },
        },
        randomUUID(),
      );
      return 'ok' as const;
    });
  } catch (error) {
    if (error instanceof ConflictError) {
      if (
        error.code === 'file_too_large' ||
        error.code === 'file_unreadable' ||
        error.code === 'no_valid_rows'
      )
        return error.code;
    }
    logEvent('onboarding.upload_failed', {
      level: 'error',
      name: error instanceof Error ? error.name : 'unknown',
    });
    return 'invalid';
  } finally {
    client.release();
  }
}

export async function savePackageAnswers(
  pool: Pool,
  token: string,
  input: z.input<typeof answersSchema>,
  deps: Deps,
): Promise<{ outcome: 'ok' | 'invalid'; proposal?: string }> {
  const parsed = answersSchema.safeParse(input);
  if (!parsed.success) return { outcome: 'invalid' };
  const client = await pool.connect();
  try {
    if (!(await admitted(client, deps, parsed.data.captchaToken))) return { outcome: 'invalid' };
    const pkg = await lookupPackage(client, token);
    if (!pkg) return { outcome: 'invalid' };
    const proposal = proposeTemplate(parsed.data.answers as Answers);
    await inPackageTenant(client, pkg, async () => {
      await client.query(
        `UPDATE onboarding_packages SET answers = $2::jsonb, proposal = $3, received_at = coalesce(received_at, now())
         WHERE id = $1`,
        [pkg.id, JSON.stringify(parsed.data.answers), proposal],
      );
      await writeAudit(
        client,
        { type: 'system', id: null },
        {
          action: 'onboarding.answers_received',
          entityType: 'onboarding_packages',
          entityId: pkg.id,
          after: { proposal },
        },
        randomUUID(),
      );
    });
    return { outcome: 'ok', proposal };
  } finally {
    client.release();
  }
}
