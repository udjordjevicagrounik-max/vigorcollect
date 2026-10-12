import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { AuthCard } from '@/components/auth/auth-card';
import { LoginForm } from '@/components/auth/login-form';
import { currentAuthContext, nextStep } from '@/server/auth/context';

export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  const ctx = await currentAuthContext();
  if (ctx.status !== 'anonymous') redirect(nextStep(ctx.status) ?? '/');
  const t = await getTranslations('auth.login');
  return (
    <AuthCard title={t('title')} description={t('description')}>
      <LoginForm />
      <p className="text-sm text-text-muted">{t('firstTime')}</p>
    </AuthCard>
  );
}
