import Link from 'next/link';
import { headers } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import { AuthCard } from '@/components/auth/auth-card';
import { InviteAccept } from '@/components/auth/invite-accept';
import { getAuth, getAuthAppPool } from '@/server/auth/better-auth';
import { previewInvitation } from '@/server/auth/invitations';

export const dynamic = 'force-dynamic';

const ROLE_KEYS = [
  'owner',
  'admin',
  'cfo',
  'finance_manager',
  'collection_manager',
  'collector',
  'sales_manager',
  'sales_rep',
  'legal_manager',
  'auditor',
  'read_only',
] as const;
type RoleKey = (typeof ROLE_KEYS)[number];
const isRoleKey = (key: string): key is RoleKey => ROLE_KEYS.some((r) => r === key);

// Public screen (docs/permissions.md): the token in the URL is the only authorization. Used,
// revoked and unknown tokens look the same; an expired one says so.
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const auth = getAuth();
  const preview = await previewInvitation(getAuthAppPool(), auth, token);
  const t = await getTranslations('auth');
  const tRoles = await getTranslations('roles');
  const loginLink = (
    <Link
      href="/login"
      className="inline-flex min-h-11 items-center justify-center rounded-md bg-brand-green px-4 font-medium text-surface hover:bg-brand-green-deep"
    >
      {t('common.backToLogin')}
    </Link>
  );

  if (preview.status === 'invalid') {
    return (
      <AuthCard title={t('invite.invalidTitle')} description={t('invite.invalidDescription')}>
        {loginLink}
      </AuthCard>
    );
  }
  if (preview.status === 'expired') {
    return (
      <AuthCard
        title={t('invite.expiredTitle')}
        description={t('invite.expiredDescription', { tenant: preview.tenantName })}
      >
        {loginLink}
      </AuthCard>
    );
  }

  const role = isRoleKey(preview.roleKey) ? tRoles(preview.roleKey) : preview.roleKey;
  const intro = (
    <>
      <p className="text-text">{t('invite.valid', { tenant: preview.tenantName, role })}</p>
      <p className="text-sm text-text-muted">{t('invite.account', { email: preview.email })}</p>
    </>
  );

  if (!preview.identityExists) {
    return (
      <AuthCard title={t('invite.title')} description={t('invite.setPassword')}>
        {intro}
        <InviteAccept token={token} existingAccount={false} />
      </AuthCard>
    );
  }

  const session = await auth.api.getSession({ headers: await headers() });
  const signedInAsInvitee = session?.user.email.toLowerCase() === preview.email.toLowerCase();
  return (
    <AuthCard title={t('invite.existingTitle')} description={t('invite.existingDescription')}>
      {intro}
      {signedInAsInvitee ? <InviteAccept token={token} existingAccount /> : loginLink}
    </AuthCard>
  );
}
