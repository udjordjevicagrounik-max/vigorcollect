import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { AuthCard } from '@/components/auth/auth-card';
import { MfaSetup } from '@/components/auth/mfa-setup';
import { currentAuthContext, nextStep } from '@/server/auth/context';

export const dynamic = 'force-dynamic';

// Mandatory TOTP enrollment: shown only while the signed-in person has no authenticator yet.
export default async function MfaSetupPage() {
  const ctx = await currentAuthContext();
  if (ctx.status !== 'mfa_setup_required') redirect(nextStep(ctx.status) ?? '/');
  const t = await getTranslations('auth.mfaSetup');
  return (
    <AuthCard title={t('title')} description={t('intro')}>
      <MfaSetup />
    </AuthCard>
  );
}
