import { getLocale, getTranslations } from 'next-intl/server';
import { ConfigurationAdmin } from '@/components/admin/configuration-admin';
import { ForbiddenState } from '@/components/admin/forbidden-state';
import { PageHeader } from '@/components/admin/page-header';
import { SettingsForm } from '@/components/admin/settings-form';
import { Screen } from '@/components/shell/screen';
import { PermissionDeniedError, permissionKeys } from '@/server/auth/permissions';
import { withTenantPage } from '@/server/auth/with-tenant';
import { codeLabels } from '@/server/receivables/service';
import {
  getThresholds,
  listAgingBounds,
  listCalendars,
  listCodes,
} from '@/server/settings/configuration';
import { availableCountries, getTenantSettings } from '@/server/settings/service';

export const dynamic = 'force-dynamic';

const TIMEZONES = Intl.supportedValuesOf('timeZone');
const CURRENCIES = Intl.supportedValuesOf('currency');

export default async function TenantSettingsPage() {
  const locale = await getLocale();
  let data;
  let config;
  try {
    [data, config] = await withTenantPage(async (ctx) => {
      const canManage = (await permissionKeys(ctx.db, ctx.userId)).has('settings.manage');
      const policies = await codeLabels(ctx, 'collection_policy', locale);
      return [
        {
          settings: await getTenantSettings(ctx),
          countries: await availableCountries(ctx),
          canManage,
        },
        {
          canManage,
          lists: {
            collection_policy: await listCodes(ctx, 'collection_policy'),
            case_stage: await listCodes(ctx, 'case_stage'),
            dispute_reason: await listCodes(ctx, 'dispute_reason'),
            payment_behaviour: await listCodes(ctx, 'payment_behaviour'),
          },
          bounds: await listAgingBounds(ctx),
          bucketLabels: await codeLabels(ctx, 'aging_bucket', locale),
          thresholds: await getThresholds(ctx),
          policies: Object.entries(policies).map(([code, label]) => ({ code, label })),
          calendars: await listCalendars(ctx),
        },
      ] as const;
    });
  } catch (error) {
    if (error instanceof PermissionDeniedError) return <ForbiddenState />;
    throw error;
  }
  const t = await getTranslations('admin.settings');
  return (
    <Screen mobileClass="mobile-full">
      <PageHeader title={t('title')} description={t('description')} />
      <SettingsForm {...data} timezones={TIMEZONES} currencies={CURRENCIES} />
      <ConfigurationAdmin {...config} />
    </Screen>
  );
}
