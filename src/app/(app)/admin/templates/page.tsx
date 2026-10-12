import { getTranslations } from 'next-intl/server';
import { ForbiddenState } from '@/components/admin/forbidden-state';
import { PageHeader } from '@/components/admin/page-header';
import { TemplateEditor } from '@/components/communication/template-editor';
import { Screen } from '@/components/shell/screen';
import { PermissionDeniedError, permissionKeys } from '@/server/auth/permissions';
import { withTenantPage } from '@/server/auth/with-tenant';
import { listTemplates } from '@/server/templates/service';
import { VARIABLES } from '@/server/templates/render';

export const dynamic = 'force-dynamic';

// Admin → Templates (task 3.2), mobile-compact: email and document templates per language;
// a saved text is a new version. Only whitelisted {{variables}} and tags are accepted.
export default async function TemplatesPage() {
  let data;
  try {
    data = await withTenantPage(async (ctx) => ({
      templates: await listTemplates(ctx),
      canManage: (await permissionKeys(ctx.db, ctx.userId)).has('settings.manage'),
    }));
  } catch (error) {
    if (error instanceof PermissionDeniedError) return <ForbiddenState />;
    throw error;
  }
  const t = await getTranslations('templatesAdmin');
  return (
    <Screen mobileClass="mobile-compact">
      <PageHeader title={t('title')} description={t('description')} />
      <p
        className="mb-4 rounded-md bg-brand-purple-soft p-3 text-xs text-text"
        data-template-variables
      >
        {t('variables')} {VARIABLES.map((v) => `{{${v}}}`).join(' ')} · {t('loop')}
      </p>
      {data.templates.length === 0 ? (
        <p className="rounded-lg border border-border bg-surface p-4 text-text-muted">
          {t('empty')}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {data.templates.map((tpl) => (
            <li key={tpl.id} data-template={tpl.key}>
              <details className="rounded-lg border border-border bg-surface">
                <summary className="flex min-h-11 cursor-pointer flex-wrap items-center gap-2 px-4">
                  <span className="font-medium text-text">{tpl.name}</span>
                  <span className="text-xs text-text-muted">
                    {t(`channel.${tpl.channel}`)} · {t('version', { version: tpl.version })}
                    {tpl.hasLegalEffect ? ` · ${t('legalEffect')}` : ''}
                  </span>
                </summary>
                <div className="border-t border-border p-4">
                  <TemplateEditor id={tpl.id} texts={tpl.texts} editable={data.canManage} />
                </div>
              </details>
            </li>
          ))}
        </ul>
      )}
    </Screen>
  );
}
