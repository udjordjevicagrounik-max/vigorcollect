import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { AuthCard } from '@/components/auth/auth-card';
import { SignOutButton } from '@/components/auth/sign-out-button';
import { TenantPicker } from '@/components/auth/tenant-picker';
import { getAuthPool } from '@/server/auth/better-auth';
import { currentAuthContext, nextStep } from '@/server/auth/context';
import { activeMemberships } from '@/server/auth/memberships';

export const dynamic = 'force-dynamic';

// Tenant choice for a person with several memberships (or to switch). Only the person's own
// active memberships are listed; the choice is re-validated by the server.
export default async function SelectTenantPage() {
  const ctx = await currentAuthContext();
  if (ctx.status === 'anonymous' || ctx.status === 'mfa_setup_required') {
    redirect(nextStep(ctx.status) ?? '/login');
  }
  const memberships =
    ctx.status === 'tenant_required'
      ? ctx.memberships
      : await activeMemberships(getAuthPool(), ctx.authUserId);
  const t = await getTranslations('auth.tenants');

  if (memberships.length === 0) {
    return (
      <AuthCard title={t('emptyTitle')} description={t('emptyDescription')}>
        <SignOutButton className="min-h-11 rounded-md bg-brand-green px-4 font-medium text-surface hover:bg-brand-green-deep" />
      </AuthCard>
    );
  }
  return (
    <AuthCard title={t('title')} description={t('description')}>
      <TenantPicker
        choices={memberships.map((m) => ({ tenantId: m.tenantId, tenantName: m.tenantName }))}
      />
      {ctx.status === 'ok' ? (
        <Link href="/" className="min-h-11 text-brand-purple underline">
          {t('choose')}
        </Link>
      ) : null}
    </AuthCard>
  );
}
