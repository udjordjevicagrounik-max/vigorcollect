import type { ReactNode } from 'react';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { SignOutButton } from '@/components/auth/sign-out-button';
import { AppNav } from '@/components/shell/app-nav';
import { requireTenantSession } from '@/server/auth/context';

export const dynamic = 'force-dynamic';

// Tenant shell: only with a complete session (password + TOTP + active membership). Anything
// else is redirected to the next step (login, MFA setup, tenant choice) — ADR 0004.
export default async function AppLayout({ children }: { children: ReactNode }) {
  await requireTenantSession();
  const t = await getTranslations('nav');
  return (
    <div className="flex flex-col md:flex-row">
      <aside className="flex flex-col gap-4 border-b border-border bg-surface p-3 md:min-h-[calc(100dvh-3.25rem)] md:w-60 md:border-b-0 md:border-r">
        <AppNav />
        <div className="flex flex-col border-t border-border pt-3" data-nav-account>
          <Link
            href="/settings/password"
            className="flex min-h-11 items-center rounded-md px-3 text-text hover:bg-brand-purple-soft"
          >
            {t('items.settingsPassword')}
          </Link>
          <SignOutButton />
        </div>
      </aside>
      <main id="main" className="flex-1">
        {children}
      </main>
    </div>
  );
}
