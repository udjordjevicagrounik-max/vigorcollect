import { getTranslations } from 'next-intl/server';
import { AuthCard } from '@/components/auth/auth-card';
import { NotificationPreferences } from '@/components/shell/notification-preferences';
import { Screen } from '@/components/shell/screen';
import { withTenantPage } from '@/server/auth/with-tenant';
import { getPreferences } from '@/server/notifications/digest';

export const dynamic = 'force-dynamic';

// Account → Notifications (5.2): the member's own digests and in-app lists.
export default async function NotificationsPage() {
  const current = await withTenantPage((ctx) => getPreferences(ctx));
  const t = await getTranslations('notifications');
  return (
    <Screen mobileClass="mobile-full">
      <AuthCard title={t('title')} description={t('description')}>
        <NotificationPreferences current={current} />
      </AuthCard>
    </Screen>
  );
}
