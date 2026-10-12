import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getAuth, getAuthPool } from './better-auth';
import { getAuthContext, type AuthContext } from './session';

// Request-scoped auth state for pages and route handlers (ADR 0004). The only way a page learns
// who is signed in and which tenant is active; withTenant() (1.2) builds on the same call.

export async function currentAuthContext(): Promise<AuthContext> {
  return getAuthContext(getAuth(), getAuthPool(), await headers());
}

/** Where a person in `status` belongs; null = may stay on a tenant page. */
export function nextStep(status: AuthContext['status']): string | null {
  switch (status) {
    case 'anonymous':
      return '/login';
    case 'mfa_setup_required':
      return '/settings/mfa-setup';
    case 'tenant_required':
      return '/select-tenant';
    case 'ok':
      return null;
  }
}

/** Page guard for tenant screens: redirects unless the session is complete (MFA + tenant). */
export async function requireTenantSession(): Promise<Extract<AuthContext, { status: 'ok' }>> {
  const ctx = await currentAuthContext();
  if (ctx.status !== 'ok') redirect(nextStep(ctx.status) ?? '/login');
  return ctx;
}
