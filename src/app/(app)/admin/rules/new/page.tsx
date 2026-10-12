import { getLocale, getTranslations } from 'next-intl/server';
import { ForbiddenState } from '@/components/admin/forbidden-state';
import { PageHeader } from '@/components/admin/page-header';
import { RuleEditor, type EditorDefinition } from '@/components/rules/rule-editor';
import { Screen } from '@/components/shell/screen';
import { PermissionDeniedError } from '@/server/auth/permissions';
import { withTenantPage } from '@/server/auth/with-tenant';
import { codeLabels } from '@/server/receivables/service';
import { editorLookups } from '../lookups';

export const dynamic = 'force-dynamic';

// The starting point of a new rule (the user changes everything in the form).
const STARTER: EditorDefinition = {
  trigger: { type: 'days_from_due', offset: 1 },
  conditions: [{ field: 'policy', op: 'eq', value: 'standard' }],
  actions: [{ type: 'create_task', kind: 'call', dueInDays: 0 }],
};

// New rule: starts as draft version 1.
export default async function NewRulePage() {
  const locale = await getLocale();
  let data;
  try {
    data = await withTenantPage(async (ctx) => {
      await ctx.requirePermission('settings.manage');
      return {
        stages: await codeLabels(ctx, 'case_stage', locale),
        nextActions: await codeLabels(ctx, 'next_action', locale),
        ...(await editorLookups(ctx)),
      };
    });
  } catch (error) {
    if (error instanceof PermissionDeniedError) return <ForbiddenState />;
    throw error;
  }
  const t = await getTranslations('rules');
  return (
    <Screen mobileClass="mobile-compact">
      <PageHeader title={t('newTitle')} description={t('newDescription')} />
      <RuleEditor
        workflowId={null}
        initialName=""
        initial={STARTER}
        editable
        hasDraft={false}
        {...data}
      />
    </Screen>
  );
}
