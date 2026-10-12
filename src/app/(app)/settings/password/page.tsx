import { getTranslations } from 'next-intl/server';
import { AuthCard } from '@/components/auth/auth-card';
import { PasswordForm } from '@/components/auth/password-form';
import { Screen } from '@/components/shell/screen';

export const dynamic = 'force-dynamic';

export default async function PasswordPage() {
  const t = await getTranslations('auth.password');
  return (
    <Screen mobileClass="mobile-full">
      <AuthCard title={t('title')} description={t('description')}>
        <PasswordForm />
      </AuthCard>
    </Screen>
  );
}
