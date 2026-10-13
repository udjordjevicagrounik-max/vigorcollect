import { getTranslations } from 'next-intl/server';
import { ForbiddenState } from '@/components/admin/forbidden-state';
import { IntegrationsAdmin } from '@/components/admin/integrations-admin';
import { PageHeader } from '@/components/admin/page-header';
import { Screen } from '@/components/shell/screen';
import { getAuthBaseURL } from '@/server/auth/better-auth';
import { PermissionDeniedError, permissionKeys } from '@/server/auth/permissions';
import { withTenantPage } from '@/server/auth/with-tenant';
import { listApiKeys, NEVER_FOR_KEYS } from '@/server/integrations/api-keys';
import { OUTBOUND_EVENT_TYPES } from '@/server/integrations/outbound';
import { listDeadLetters, listIntegrations, listSyncRuns } from '@/server/integrations/service';

export const dynamic = 'force-dynamic';

// Admin → Integrations (task 4.1), mobile-compact: integrations (n8n) with their inbound URL,
// test ping and on/off; API keys (token shown once); dead letters with retry (rule 95); sync log.
export default async function IntegrationsPage() {
  let data;
  try {
    data = await withTenantPage(async (ctx) => {
      const integrations = await listIntegrations(ctx);
      const keys = await permissionKeys(ctx.db, ctx.userId);
      return {
        integrations,
        apiKeys: await listApiKeys(ctx),
        syncRuns: await listSyncRuns(ctx),
        deadLetters: await listDeadLetters(ctx),
        canManage: keys.has('integration.manage'),
        grantableScopes: [...keys].filter((k) => !NEVER_FOR_KEYS.has(k)).sort(),
      };
    });
  } catch (error) {
    if (error instanceof PermissionDeniedError) return <ForbiddenState />;
    throw error;
  }
  const t = await getTranslations('integrationsAdmin');
  const origin = new URL(getAuthBaseURL()).origin;
  return (
    <Screen mobileClass="mobile-compact">
      <PageHeader title={t('title')} description={t('description')} />
      <IntegrationsAdmin
        integrations={data.integrations.map((i) => ({
          ...i,
          inboundUrl: `${origin}${i.inboundPath}`,
        }))}
        apiKeys={data.apiKeys}
        syncRuns={data.syncRuns}
        deadLetters={data.deadLetters}
        canManage={data.canManage}
        events={OUTBOUND_EVENT_TYPES}
        grantableScopes={data.grantableScopes}
        origin={origin}
      />
    </Screen>
  );
}
