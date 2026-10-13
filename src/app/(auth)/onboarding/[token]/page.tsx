import { headers } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import { AuthCard } from '@/components/auth/auth-card';
import { PackageForm } from '@/components/platform/package-form';
import { getAuthAppPool } from '@/server/auth/better-auth';
import { lookupPackage } from '@/server/platform/service';
import { turnstileFromEnv } from '@/server/security/turnstile';

export const dynamic = 'force-dynamic';

// Public screen (docs/permissions.md, rule 27): the client's data package. The token is the only
// authorization; an unknown and an expired link look the same.
export default async function PackagePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const t = await getTranslations('package');
  const pkg = await lookupPackage(getAuthAppPool(), token);
  if (!pkg)
    return (
      <AuthCard title={t('invalidTitle')} description={t('invalidDescription')}>
        {null}
      </AuthCard>
    );
  const siteKey = turnstileFromEnv()?.siteKey ?? null;
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return (
    <AuthCard title={t('title', { tenant: pkg.tenantName })} description={t('description')}>
      <PackageForm
        token={token}
        siteKey={siteKey}
        nonce={nonce}
        files={pkg.files}
        answered={pkg.answered}
      />
    </AuthCard>
  );
}
