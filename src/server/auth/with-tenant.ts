import { headers as requestHeaders } from 'next/headers';
import { redirect } from 'next/navigation';
import { NextResponse, type NextRequest } from 'next/server';
import type { Pool, PoolClient } from 'pg';
import { ZodError } from 'zod';
import { apiError, type ApiErrorCode } from '@/lib/api-error';
import { logEvent } from '@/lib/log';
import { APP_VERSION_HEADER, REQUEST_ID_HEADER, resolveRequestId } from '@/lib/request-id';
import { getAppVersion } from '@/lib/version';
import { reportError } from '@/server/observability/sentry';
import { writeAudit, type AuditEntry } from './audit';
import { getAuth, getAuthAppPool, getAuthBaseURL, getAuthPool } from './better-auth';
import {
  checkPermission,
  PermissionDeniedError,
  UnknownPermissionError,
  type PermissionGrant,
} from './permissions';
import { currentAuthContext, nextStep } from './context';
import { getAuthContext } from './session';

/**
 * withTenant(handler) — rule 2, task 1.2. Every tenant API route is wrapped in it:
 *
 *   1. the tenant comes ONLY from getAuthContext() (verified session + MFA + active membership)
 *      — never from body, query, header or URL; anything else → 401;
 *   2. one transaction with SET LOCAL app.tenant_id; app.auth_user_id is RESET (the pre-tenant
 *      bridge policy must never apply inside a tenant transaction);
 *   3. fail closed: a handler that never called requirePermission() → 500; a successful
 *      mutation (POST/PUT/PATCH/DELETE) without audit() → 500; both roll back;
 *   4. errors (one shape: {code, message_key, request_id} — src/lib/api-error.ts): forbidden →
 *      403 without detail; NotFoundError → 404 (also for another tenant's id: the row is
 *      invisible, so IDOR looks like "does not exist"); invalid input → 400; unknown permission
 *      key → 500 + error log; never a stack; X-Request-Id / X-App-Version on every answer;
 *   5. CSRF (1.4): a mutating request must come from our own origin (Origin header = the
 *      BETTER_AUTH_URL origin, or Sec-Fetch-Site: same-origin); SameSite=Lax is the second layer.
 */

export class NotFoundError extends Error {
  override name = 'NotFoundError';
  constructor() {
    super('not found');
  }
}

/** Input that passed the schema but is not acceptable (e.g. an unknown country) → 400. */
export class InvalidRequestError extends Error {
  override name = 'InvalidRequestError';
  constructor() {
    super('invalid request');
  }
}

/** Domain conflict the client can act on (e.g. "invitation is not pending"); code only. */
export class ConflictError extends Error {
  override name = 'ConflictError';
  constructor(readonly code: ApiErrorCode) {
    super(code);
  }
}

export type TenantContext = {
  db: PoolClient;
  tenantId: string;
  /** public.users id of the signed-in member. */
  userId: string;
  authUserId: string;
  requestId: string;
  requirePermission(key: string): Promise<PermissionGrant>;
  /** The first of `keys` the member holds (e.g. different checkers per request type). */
  requireAnyPermission(keys: readonly string[]): Promise<PermissionGrant>;
  audit(entry: AuditEntry): Promise<void>;
};

type Identity = Pick<TenantContext, 'tenantId' | 'userId' | 'authUserId' | 'requestId'>;
type Tracking = { permissionChecked: boolean; audits: number };

/** Builds the context on a client that is ALREADY inside the tenant transaction. */
export function createTenantContext(
  db: PoolClient,
  identity: Identity,
  tracking: Tracking = { permissionChecked: false, audits: 0 },
): TenantContext {
  return {
    db,
    ...identity,
    async requirePermission(key) {
      tracking.permissionChecked = true;
      return checkPermission(db, identity.userId, key);
    },
    async requireAnyPermission(keys) {
      tracking.permissionChecked = true;
      for (const key of keys) {
        try {
          return await checkPermission(db, identity.userId, key);
        } catch (error) {
          if (!(error instanceof PermissionDeniedError)) throw error;
        }
      }
      throw new PermissionDeniedError();
    },
    async audit(entry) {
      await writeAudit(db, { type: 'user', id: identity.userId }, entry, identity.requestId);
      tracking.audits += 1;
    },
  };
}

export type RouteContext<P> = { params: Promise<P> };
export type TenantHandler<P> = (
  request: NextRequest,
  ctx: TenantContext,
  params: P,
) => Promise<Response>;

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function fail(status: number, code: ApiErrorCode, requestId: string): NextResponse {
  return withHeaders(apiError(status, code, requestId), requestId);
}

/** Mutations only from our own origin (CSRF, task 1.4). */
export function sameOrigin(headers: Headers, allowedOrigin: string): boolean {
  const origin = headers.get('origin');
  if (origin) return origin === allowedOrigin;
  return headers.get('sec-fetch-site') === 'same-origin';
}

function withHeaders<R extends Response>(response: R, requestId: string): R {
  response.headers.set(REQUEST_ID_HEADER, requestId);
  response.headers.set(APP_VERSION_HEADER, getAppVersion());
  response.headers.set('cache-control', 'no-store');
  return response;
}

export type WithTenantDeps = {
  appPool: () => Pool;
  resolveIdentity: typeof sessionIdentity;
  allowedOrigin: () => string;
};

/** Session → tenant identity, or null when the session is not complete. */
export async function sessionIdentity(
  headers: Headers,
): Promise<Omit<Identity, 'requestId'> | null> {
  const ctx = await getAuthContext(getAuth(), getAuthPool(), headers);
  if (ctx.status !== 'ok') return null;
  return { tenantId: ctx.tenantId, userId: ctx.userId, authUserId: ctx.authUserId };
}

export function withTenant<P = Record<string, never>>(
  handler: TenantHandler<P>,
  deps: WithTenantDeps = {
    appPool: getAuthAppPool,
    resolveIdentity: sessionIdentity,
    allowedOrigin: () => new URL(getAuthBaseURL()).origin,
  },
): (request: NextRequest, route: RouteContext<P>) => Promise<Response> {
  return async (request, route) => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    if (MUTATING.has(request.method) && !sameOrigin(request.headers, deps.allowedOrigin())) {
      logEvent('security.forbidden_origin', {
        level: 'warn',
        requestId,
        path: request.nextUrl.pathname,
      });
      return fail(403, 'forbidden_origin', requestId);
    }
    const identity = await deps.resolveIdentity(request.headers);
    if (!identity) return fail(401, 'unauthorized', requestId);

    const tracking: Tracking = { permissionChecked: false, audits: 0 };
    const client = await deps.appPool().connect();
    try {
      await client.query('BEGIN');
      await client.query('RESET app.auth_user_id');
      await client.query('RESET app.invite_token_hash');
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [identity.tenantId]);
      const ctx = createTenantContext(client, { ...identity, requestId }, tracking);
      const response = await handler(request, ctx, await route.params);

      if (!tracking.permissionChecked) {
        await client.query('ROLLBACK');
        logEvent('error.permission_not_checked', {
          level: 'error',
          requestId,
          path: request.nextUrl.pathname,
        });
        return fail(500, 'internal', requestId);
      }
      if (MUTATING.has(request.method) && response.status < 300 && tracking.audits === 0) {
        await client.query('ROLLBACK');
        logEvent('error.mutation_without_audit', {
          level: 'error',
          requestId,
          path: request.nextUrl.pathname,
        });
        return fail(500, 'internal', requestId);
      }
      await client.query(response.status < 400 ? 'COMMIT' : 'ROLLBACK');
      return withHeaders(response, requestId);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (error instanceof PermissionDeniedError) return fail(403, 'forbidden', requestId);
      if (error instanceof NotFoundError) return fail(404, 'not_found', requestId);
      if (error instanceof ConflictError) return fail(409, error.code, requestId);
      if (error instanceof ZodError || error instanceof InvalidRequestError) {
        return fail(400, 'invalid_request', requestId);
      }
      if (error instanceof UnknownPermissionError) {
        // Sentry-ready: level + stable event name + request id; the key is not personal data.
        logEvent('error.unknown_permission', { level: 'error', requestId, permission: error.key });
        return fail(500, 'internal', requestId);
      }
      reportError(error, { request_id: requestId, path: request.nextUrl.pathname });
      logEvent('error.unhandled', {
        level: 'error',
        requestId,
        name: error instanceof Error ? error.name : 'unknown',
        code: (error as { code?: unknown })?.code
          ? String((error as { code?: unknown }).code)
          : null,
      });
      return fail(500, 'internal', requestId);
    } finally {
      client.release();
    }
  };
}

/**
 * Server components (pages) — the same guarantees as withTenant(): tenant ONLY from the session,
 * SET LOCAL app.tenant_id, pre-tenant GUCs reset — in a READ ONLY transaction (pages never
 * write; mutations go through API routes). An incomplete session is redirected to its next
 * step. ctx.requirePermission() throws PermissionDeniedError — the page shows its "no access"
 * state.
 */
export async function withTenantPage<T>(fn: (ctx: TenantContext) => Promise<T>): Promise<T> {
  const auth = await currentAuthContext();
  if (auth.status !== 'ok') redirect(nextStep(auth.status) ?? '/login');
  const requestId = resolveRequestId((await requestHeaders()).get(REQUEST_ID_HEADER));
  const client = await getAuthAppPool().connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query('RESET app.auth_user_id');
    await client.query('RESET app.invite_token_hash');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [auth.tenantId]);
    const ctx = createTenantContext(client, {
      tenantId: auth.tenantId,
      userId: auth.userId,
      authUserId: auth.authUserId,
      requestId,
    });
    const result = await fn(ctx);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
