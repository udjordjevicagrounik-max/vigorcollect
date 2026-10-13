import { createHash, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import { logEvent } from '@/lib/log';
import { permissionKeys, PermissionDeniedError } from '@/server/auth/permissions';
import {
  ConflictError,
  InvalidRequestError,
  NotFoundError,
  type TenantContext,
} from '@/server/auth/with-tenant';
import type { Queryable } from '@/server/crypto/subject-keys';

/**
 * API keys per tenant (task 4.1) — how n8n (or any integration) calls our API.
 *
 *   Authorization: Bearer ak_<43 chars base64url>   (256 random bits)
 *
 * Only SHA-256(token) is stored; the token is returned ONCE by createApiKey() for the UI and is
 * never logged. A call with a key goes through the same withTenant() as a person: the tenant
 * comes from the key row (found by hash through the api_key_lookup policy, pre-tenant), every
 * route still calls requirePermission(), which a key passes only for keys in its scopes; the
 * audit actor is 'api_key'. Scopes are permission keys of the catalog that the creating member
 * holds, minus the checker permissions — maker-checker always needs a person (rule 11).
 */

export const TOKEN_PREFIX = 'ak_';
const TOKEN_RE = /^ak_[A-Za-z0-9_-]{43}$/;

/** Checker permissions (🅼 in docs/permissions.md) — never given to a key. */
export const NEVER_FOR_KEYS = new Set([
  'user.assign',
  'role.manage',
  'decision.approve',
  'approval.write_off',
  'approval.credit_limit',
  'approval.block_customer',
  'approval.legal_handover',
  'approval.risk_override',
]);

export const hashToken = (token: string): Buffer => createHash('sha256').update(token).digest();

export type ApiKeyIdentity = {
  apiKeyId: string;
  tenantId: string;
  scopes: string[];
  rateLimitPerMinute: number;
};

export class RateLimitedError extends Error {
  override name = 'RateLimitedError';
  constructor(readonly retryAfter: number) {
    super('rate limited');
  }
}

/** Bearer token from the Authorization header, or null (then the session decides). */
export function bearerToken(headers: Headers): string | null {
  const value = headers.get('authorization');
  if (!value?.startsWith('Bearer ')) return null;
  return value.slice('Bearer '.length).trim();
}

/**
 * Token → identity, or null (unknown, revoked, malformed — all look the same). Pre-tenant: one
 * short transaction that sees exactly the row with this hash. Then the per-key rate limit.
 */
export async function apiKeyIdentity(pool: Pool, token: string): Promise<ApiKeyIdentity | null> {
  if (!TOKEN_RE.test(token)) return null;
  const client = await pool.connect();
  let found: ApiKeyIdentity | null = null;
  try {
    await client.query('BEGIN');
    await client.query('RESET app.tenant_id');
    await client.query("SELECT set_config('app.api_key_hash', $1, true)", [
      hashToken(token).toString('hex'),
    ]);
    const { rows } = await client.query<{
      id: string;
      tenant_id: string;
      scopes: string[];
      rate_limit_per_minute: number;
    }>(
      `SELECT id, tenant_id, scopes, rate_limit_per_minute FROM api_keys
       WHERE key_hash = app_api_key_hash() AND revoked_at IS NULL`,
    );
    await client.query('COMMIT');
    const r = rows[0];
    if (r)
      found = {
        apiKeyId: r.id,
        tenantId: r.tenant_id,
        scopes: r.scopes,
        rateLimitPerMinute: r.rate_limit_per_minute,
      };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  if (!found) return null;
  const limit = await pool.query<{ allowed: boolean; retry_after: number }>(
    'SELECT allowed, retry_after FROM api_rate_limit_hit($1, 60, $2)',
    [`api_key:${found.apiKeyId}`, found.rateLimitPerMinute],
  );
  if (limit.rows[0] && !limit.rows[0].allowed) {
    logEvent('api_key.rate_limited', { level: 'warn', apiKeyId: found.apiKeyId });
    throw new RateLimitedError(limit.rows[0].retry_after);
  }
  return found;
}

/** Inside the tenant transaction: remember the last use (at most once a minute per key). */
export async function touchApiKey(db: Queryable, apiKeyId: string): Promise<void> {
  await db.query(
    `UPDATE api_keys SET last_used_at = now()
     WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`,
    [apiKeyId],
  );
}

// ---------------------------------------------------------------------------------------------
// Management (Admin → Integrations): integration.manage; list: integration.read
// ---------------------------------------------------------------------------------------------

export const newApiKeySchema = z.object({
  name: z.string().trim().min(1).max(120),
  scopes: z
    .array(z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/))
    .min(1)
    .max(100),
  rateLimitPerMinute: z.number().int().min(1).max(6000).default(60),
});

export type ApiKeyRow = {
  id: string;
  name: string;
  tokenPrefix: string;
  scopes: string[];
  rateLimitPerMinute: number;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

export async function listApiKeys(ctx: TenantContext): Promise<ApiKeyRow[]> {
  await ctx.requirePermission('integration.read');
  const { rows } = await ctx.db.query<{
    id: string;
    name: string;
    token_prefix: string;
    scopes: string[];
    rate_limit_per_minute: number;
    created_at: Date;
    last_used_at: Date | null;
    revoked_at: Date | null;
  }>(
    `SELECT id, name, token_prefix, scopes, rate_limit_per_minute, created_at, last_used_at, revoked_at
     FROM api_keys ORDER BY revoked_at NULLS FIRST, created_at DESC`,
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    tokenPrefix: r.token_prefix,
    scopes: r.scopes,
    rateLimitPerMinute: r.rate_limit_per_minute,
    createdAt: r.created_at.toISOString(),
    lastUsedAt: r.last_used_at?.toISOString() ?? null,
    revokedAt: r.revoked_at?.toISOString() ?? null,
  }));
}

/** Creates a key; the token is in the answer ONCE (for the UI) and nowhere else. */
export async function createApiKey(
  ctx: TenantContext,
  input: z.input<typeof newApiKeySchema>,
): Promise<{ id: string; token: string; tokenPrefix: string }> {
  await ctx.requirePermission('integration.manage');
  const data = newApiKeySchema.parse(input);
  const scopes = [...new Set(data.scopes)].sort();
  const mine = await permissionKeys(ctx.db, ctx.userId);
  if (scopes.some((s) => NEVER_FOR_KEYS.has(s))) throw new InvalidRequestError();
  // No escalation: a key can do at most what its creator can.
  if (scopes.some((s) => !mine.has(s))) throw new PermissionDeniedError();
  const known = await ctx.db.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM permissions WHERE key = ANY($1::text[])',
    [scopes],
  );
  if (known.rows[0]?.n !== scopes.length) throw new InvalidRequestError();
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  const tokenPrefix = token.slice(0, 12);
  const { rows } = await ctx.db.query<{ id: string }>(
    `INSERT INTO api_keys (tenant_id, name, token_prefix, key_hash, scopes, rate_limit_per_minute, created_by)
     VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6) RETURNING id`,
    [data.name, tokenPrefix, hashToken(token), scopes, data.rateLimitPerMinute, ctx.userId],
  );
  const id = rows[0]?.id ?? '';
  await ctx.audit({
    action: 'api_key.created',
    entityType: 'api_keys',
    entityId: id,
    after: {
      name: data.name,
      token_prefix: tokenPrefix,
      scopes,
      rate_limit_per_minute: data.rateLimitPerMinute,
    },
  });
  return { id, token, tokenPrefix };
}

export async function revokeApiKey(ctx: TenantContext, id: string): Promise<{ ok: true }> {
  await ctx.requirePermission('integration.manage');
  const res = await ctx.db.query(
    `UPDATE api_keys SET revoked_at = now(), revoked_by = $2 WHERE id = $1 AND revoked_at IS NULL`,
    [id, ctx.userId],
  );
  if (!res.rowCount) {
    const exists = await ctx.db.query('SELECT 1 FROM api_keys WHERE id = $1', [id]);
    if (!exists.rowCount) throw new NotFoundError();
    throw new ConflictError('conflict');
  }
  await ctx.audit({ action: 'api_key.revoked', entityType: 'api_keys', entityId: id });
  return { ok: true };
}
