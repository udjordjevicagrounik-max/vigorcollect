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

export const dynamic = 'force-dynamic';

// Tenant shell: only with a complete session (password + TOTP + active membership); anything
// else is redirected to its next step (ADR 0004). Navigation is built from the member's
// permissions; the tenant badge offers a switch when the person has several memberships.
export default async function AppLayout({ children }: { children: ReactNode }) {
  const shell = await withTenantPage(async (ctx) => {
    const { rows } = await ctx.db.query<{ display_name: string }>(
      'SELECT display_name FROM tenants',
    );
    return {
      tenantName: rows[0]?.display_name ?? '',
      permissions: [...(await permissionKeys(ctx.db, ctx.userId))],
      authUserId: ctx.authUserId,
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
        <AppNav permissions={shell.permissions} />
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
          <InstallPrompt />
          <SignOutButton />
        </div>
      </aside>
      <main id="main" className="min-w-0 flex-1">
        {children}
      </main>
    </div>
  );
}
