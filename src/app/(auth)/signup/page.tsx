import { headers } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import { AuthCard } from '@/components/auth/auth-card';
import { SignupForm } from '@/components/platform/signup-form';
import { getAuthAppPool } from '@/server/auth/better-auth';
import { turnstileFromEnv } from '@/server/security/turnstile';

export const dynamic = 'force-dynamic';

// Public screen (docs/permissions.md): try the product in a 7-day sandbox with demo data.
export default async function SignupPage() {
  const t = await getTranslations('signup');
  const siteKey = turnstileFromEnv()?.siteKey ?? null;
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  const { rows } = await getAuthAppPool().query<{ code: string }>(
    `SELECT country_code AS code FROM jurisdiction_profiles WHERE country_code <> 'XX' ORDER BY country_code`,
  );
  const countries = rows.length ? rows.map((r) => r.code) : ['RS'];
  return (
    <AuthCard title={t('title')} description={t('description')}>
      <SignupForm siteKey={siteKey} nonce={nonce} countries={countries} />
    </AuthCard>
  );
}
