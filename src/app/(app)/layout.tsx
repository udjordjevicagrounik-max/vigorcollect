import type { ReactNode } from 'react';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { SignOutButton } from '@/components/auth/sign-out-button';
import { AppNav } from '@/components/shell/app-nav';
import { GlobalSearch } from '@/components/shell/global-search';
import { InstallPrompt } from '@/components/shell/install-prompt';
import { getAuthPool } from '@/server/auth/better-auth';
import { activeMemberships } from '@/server/auth/memberships';
import { permissionKeys } from '@/server/auth/permissions';
import { withTenantPage } from '@/server/auth/with-tenant';
import { onboardingState } from '@/server/onboarding/service';

export const dynamic = 'force-dynamic';

// 6.4: trial / sandbox countdown, or read-only after expiry (nothing is deleted then).
function lifecycleBanner(
  r:
    | {
        lifecycle_status: string;
        trial_ends_at: Date | null;
        sandbox_expires_at: Date | null;
        writable: boolean;
      }
    | undefined,
): { kind: 'readOnly' | 'trial' | 'sandbox'; days: number } | null {
  if (!r) return null;
  if (!r.writable) return { kind: 'readOnly', days: 0 };
  const end =
    r.lifecycle_status === 'trial'
      ? r.trial_ends_at
      : r.lifecycle_status === 'sandbox'
        ? r.sandbox_expires_at
        : null;
  if (!end) return null;
  const days = Math.max(0, Math.ceil((end.getTime() - Date.now()) / 86_400_000));
  return { kind: r.lifecycle_status as 'trial' | 'sandbox', days };
}

// Tenant shell: only with a complete session (password + TOTP + active membership); anything
// else is redirected to its next step (ADR 0004). Navigation is built from the member's
// permissions; the tenant badge offers a switch when the person has several memberships.
export default async function AppLayout({ children }: { children: ReactNode }) {
  const shell = await withTenantPage(async (ctx) => {
    const { rows } = await ctx.db.query<{
      display_name: string;
      lifecycle_status: string;
      trial_ends_at: Date | null;
      sandbox_expires_at: Date | null;
      writable: boolean;
      is_platform_operator: boolean;
    }>(
      `SELECT display_name, lifecycle_status, trial_ends_at, sandbox_expires_at, is_platform_operator,
              tenant_writable(t) AS writable
       FROM tenants t`,
    );
    // platform.manage counts only in the platform operator tenant (requirePlatform does the same).
    const permissions = [...(await permissionKeys(ctx.db, ctx.userId))].filter(
      (k) => k !== 'platform.manage' || rows[0]?.is_platform_operator,
    );
    return {
      tenantName: rows[0]?.display_name ?? '',
      lifecycle: lifecycleBanner(rows[0]),
      permissions,
      authUserId: ctx.authUserId,
      // 5.4: "Getting started" stays in the navigation until every step is done.
      onboarding: permissions.includes('settings.read') ? await onboardingState(ctx) : null,
    };
  });
  const memberships = await activeMemberships(getAuthPool(), shell.authUserId);
  const t = await getTranslations('nav');
  return (
    <div className="flex flex-col md:flex-row">
      <aside className="flex flex-col gap-4 border-b border-border bg-surface p-3 md:min-h-[calc(100dvh-3.25rem)] md:w-60 md:border-b-0 md:border-r">
        <div data-tenant-badge className="rounded-md bg-brand-purple-soft px-3 py-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">
            {t('tenant')}
          </p>
          <p className="font-medium text-text">{shell.tenantName}</p>
          {memberships.length > 1 ? (
            <Link
              href="/select-tenant"
              className="inline-flex min-h-11 items-center text-sm text-brand-purple underline"
            >
              {t('switchTenant')}
            </Link>
          ) : null}
        </div>
        {shell.permissions.includes('customer.read') ? <GlobalSearch /> : null}
        <AppNav
          permissions={shell.permissions}
          onboarding={
            shell.onboarding && !shell.onboarding.complete
              ? { done: shell.onboarding.done, total: shell.onboarding.total }
              : null
          }
        />
        <div className="flex flex-col border-t border-border pt-3" data-nav-account>
          <p className="px-3 text-xs font-semibold uppercase tracking-wide text-text-muted">
            {t('account')}
          </p>
          <Link
            href="/settings/password"
            className="flex min-h-11 items-center rounded-md px-3 text-text hover:bg-brand-purple-soft"
          >
            {t('items.settingsPassword')}
          </Link>
          <Link
            href="/settings/notifications"
            className="flex min-h-11 items-center rounded-md px-3 text-text hover:bg-brand-purple-soft"
          >
            {t('items.notifications')}
          </Link>
          <InstallPrompt />
          <SignOutButton />
        </div>
      </aside>
      <main id="main" className="min-w-0 flex-1">
        {shell.lifecycle ? (
          <p
            role="status"
            data-lifecycle-banner={shell.lifecycle.kind}
            className="border-b border-border bg-brand-purple-soft px-4 py-2 text-sm text-text"
          >
            {t(`lifecycle.${shell.lifecycle.kind}`, { days: shell.lifecycle.days })}
          </p>
        ) : null}
        {children}
      </main>
    </div>
  );
}
