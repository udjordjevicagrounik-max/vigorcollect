import { getTranslations } from 'next-intl/server';
import { AuthCard } from '@/components/auth/auth-card';
import { MfaForm } from '@/components/auth/mfa-form';

export const dynamic = 'force-dynamic';

// Reached after a correct password when TOTP is enabled. The pending second factor lives in
// Better Auth's short-lived two-factor cookie; without it the form says "sign in again".
export default async function MfaPage() {
  const t = await getTranslations('auth.mfa');
  return (
    <AuthCard title={t('title')} description={t('description')}>
      <MfaForm />
    </AuthCard>
  );
}
