import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { ForbiddenState } from '@/components/admin/forbidden-state';
import { PageHeader } from '@/components/admin/page-header';
import { Screen } from '@/components/shell/screen';
import { PermissionDeniedError, permissionKeys } from '@/server/auth/permissions';
import { withTenantPage } from '@/server/auth/with-tenant';
import { listWorkflows } from '@/server/workflows/service';

export const dynamic = 'force-dynamic';

// Admin → Rules (task 3.1), mobile-compact: rules with published / open version and 7-day runs.
export default async function RulesPage() {
  let data;
  try {
    data = await withTenantPage(async (ctx) => ({
      workflows: await listWorkflows(ctx),
      canManage: (await permissionKeys(ctx.db, ctx.userId)).has('settings.manage'),
    }));
  } catch (error) {
    if (error instanceof PermissionDeniedError) return <ForbiddenState />;
    throw error;
  }
  const t = await getTranslations('rules');
  return (
    <Screen mobileClass="mobile-compact">
      <PageHeader title={t('title')} description={t('description')} />
      {data.canManage ? (
        <Link
          href="/admin/rules/new"
          className="mb-4 inline-flex min-h-11 items-center rounded-md bg-brand-green px-4 font-medium text-surface"
          data-rule-new
        >
          {t('new')}
        </Link>
      ) : null}
      {data.workflows.length === 0 ? (
        <section className="rounded-lg border border-border bg-surface p-6 text-center">
          <h2 className="font-semibold text-brand-green">{t('emptyTitle')}</h2>
          <p className="mx-auto mt-2 max-w-prose text-text-muted">{t('emptyDescription')}</p>
        </section>
      ) : (
        <ul className="flex flex-col gap-2">
          {data.workflows.map((w) => (
            <li key={w.id} data-rule={w.key}>
              <Link
                href={`/admin/rules/${w.id}`}
                className="block rounded-lg border border-border bg-surface p-3 hover:bg-brand-purple-soft"
              >
                <span className="font-medium text-text">{w.name}</span>
                <span className="block text-sm text-text-muted">
                  {w.publishedVersion
                    ? t('published', { version: w.publishedVersion })
                    : t('notPublished')}
                  {w.openVersion
                    ? ` · ${t(`versionStatus.${w.openVersion.status as 'draft'}`)} v${w.openVersion.version}`
                    : ''}
                </span>
                <span className="block text-xs text-text-muted">
                  {t('runs7d', {
                    succeeded: w.runs7d.succeeded,
                    skipped: w.runs7d.skipped,
                    failed: w.runs7d.failed,
                  })}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Screen>
  );
}
