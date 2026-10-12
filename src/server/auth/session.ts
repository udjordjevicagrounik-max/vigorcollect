import type { Pool } from 'pg';
import type { Auth } from './better-auth';
import { activeMemberships, type Membership } from './memberships';

/**
 * The request's authentication state (ADR 0004). Tenant data is reachable only in state `ok`:
 * a valid Better Auth session, TOTP enabled (MFA is mandatory) and an active membership in the
 * session's activeTenantId — re-checked on every request, so a disabled membership ends access
 * immediately. withTenant() (task 1.2) takes tenantId from here and from nowhere else (rule 2).
 */
export type AuthContext =
  | { status: 'anonymous' }
  | { status: 'mfa_setup_required'; authUserId: string }
  | { status: 'tenant_required'; authUserId: string; memberships: Membership[] }
  | { status: 'ok'; authUserId: string; tenantId: string; userId: string; sessionId: string };

export async function getAuthContext(
  auth: Auth,
  pool: Pool,
  headers: Headers,
): Promise<AuthContext> {
  const result = await auth.api.getSession({ headers, query: { disableCookieCache: true } });
  if (!result) return { status: 'anonymous' };
  const { user, session } = result;
  if (!user.twoFactorEnabled) return { status: 'mfa_setup_required', authUserId: user.id };

  const memberships = await activeMemberships(pool, user.id);
  const active = memberships.find((m) => m.tenantId === session.activeTenantId);
  if (!active) return { status: 'tenant_required', authUserId: user.id, memberships };
  return {
    status: 'ok',
    authUserId: user.id,
    tenantId: active.tenantId,
    userId: active.userId,
    sessionId: session.id,
  };
}
