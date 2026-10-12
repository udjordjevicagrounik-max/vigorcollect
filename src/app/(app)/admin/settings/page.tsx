import { getTranslations } from 'next-intl/server';
import { ForbiddenState } from '@/components/admin/forbidden-state';
import { PageHeader } from '@/components/admin/page-header';
import { SettingsForm } from '@/components/admin/settings-form';
import { Screen } from '@/components/shell/screen';
import { PermissionDeniedError, permissionKeys } from '@/server/auth/permissions';
import { withTenantPage } from '@/server/auth/with-tenant';
import { availableCountries, getTenantSettings } from '@/server/settings/service';

export const dynamic = 'force-dynamic';

const TIMEZONES = Intl.supportedValuesOf('timeZone');
const CURRENCIES = Intl.supportedValuesOf('currency');

export default async function TenantSettingsPage() {
  let data;
  try {
    data = await withTenantPage(async (ctx) => ({
      settings: await getTenantSettings(ctx),
      countries: await availableCountries(ctx),
      canManage: (await permissionKeys(ctx.db, ctx.userId)).has('settings.manage'),
    }));
  } catch (error) {
    if (error instanceof PermissionDeniedError) return <ForbiddenState />;
    throw error;
  }
  const t = await getTranslations('admin.settings');
  return (
    <Screen mobileClass="mobile-full">
      <PageHeader title={t('title')} description={t('description')} />
      <SettingsForm {...data} timezones={TIMEZONES} currencies={CURRENCIES} />
    </Screen>
  );
}
