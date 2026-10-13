import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { z } from 'zod';
import { ForbiddenState } from '@/components/admin/forbidden-state';
import { RuleEditor, type EditorDefinition } from '@/components/rules/rule-editor';
import { RunExplanation } from '@/components/rules/run-explanation';
import { Screen } from '@/components/shell/screen';
import { PermissionDeniedError, permissionKeys } from '@/server/auth/permissions';
import { NotFoundError, withTenantPage } from '@/server/auth/with-tenant';
import { codeLabels } from '@/server/receivables/service';
import { getWorkflow } from '@/server/workflows/service';
import { editorLookups } from '../lookups';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.uuid() });
const WHEN = { dateStyle: 'medium', timeStyle: 'short' } as const;

// One rule: versions (status, who published), the editable draft (or the published definition
// to start a new version from), and the last 50 runs with their explanation.
export default async function RulePage({ params }: { params: Promise<{ id: string }> }) {
  const parsed = paramsSchema.safeParse(await params);
  if (!parsed.success) notFound();
  const locale = await getLocale();
  let data;
  try {
    data = await withTenantPage(async (ctx) => {
      const wf = await getWorkflow(ctx, parsed.data.id);
      const canManage = (await permissionKeys(ctx.db, ctx.userId)).has('settings.manage');
      return {
        wf,
        canManage,
        stages: await codeLabels(ctx, 'case_stage', locale),
        nextActions: await codeLabels(ctx, 'next_action', locale),
        ...(canManage ? await editorLookups(ctx) : { users: [], teams: [] }),
      };
    });
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    if (error instanceof PermissionDeniedError) return <ForbiddenState />;
    throw error;
  }
  const t = await getTranslations('rules');
  const format = await getFormatter();
  const { wf } = data;
  const open = wf.versions.find((v) => v.status === 'draft' || v.status === 'pending_approval');
  const published = wf.versions.find((v) => v.status === 'published');
  const base = open ?? published ?? wf.versions[0];
  return (
    <Screen mobileClass="mobile-compact">
      <header className="mb-4">
        <p className="text-sm">
          <Link href="/admin/rules" className="text-brand-purple underline">
            {t('back')}
          </Link>
        </p>
        <h1 className="mt-1 text-xl font-semibold text-brand-green" data-rule-title>
          {wf.name}
        </h1>
        <span aria-hidden="true" className="mt-2 block h-[3px] w-12 bg-brand-gold" />
        <p className="mt-2 text-sm text-text-muted">
          {published ? t('published', { version: published.version }) : t('notPublished')}
          {open ? ` · ${t(`versionStatus.${open.status as 'draft'}`)} v${open.version}` : ''}
        </p>
      </header>

      {open?.status === 'pending_approval' ? (
        <p
          className="mb-4 rounded-md border border-status-warning-fg bg-status-warning-bg p-3 text-sm text-status-warning-fg"
          data-rule-pending
        >
          {t('pendingNotice')}
        </p>
      ) : null}

      {base?.definition ? (
        <RuleEditor
          workflowId={wf.id}
          initialName={wf.name}
          initial={base.definition as EditorDefinition}
          editable={data.canManage && open?.status !== 'pending_approval'}
          hasDraft={open?.status === 'draft'}
          stages={data.stages}
          nextActions={data.nextActions}
          users={data.users}
          teams={data.teams}
        />
      ) : (
        <p className="text-status-danger-fg">{t('invalidDefinition')}</p>
      )}

      <section aria-labelledby="rule-versions" className="mt-6">
        <h2 id="rule-versions" className="font-semibold text-text">
          {t('versions')}
        </h2>
        <ul className="mt-2 flex flex-col gap-1 text-sm">
          {wf.versions.map((v) => (
            <li key={v.id} data-version={v.version} data-version-status={v.status}>
              {t('versionLabel', { version: v.version })} ·{' '}
              {t(`versionStatus.${v.status as 'draft'}`)}
              {v.publishedAt ? ` · ${format.dateTime(new Date(v.publishedAt), WHEN)}` : ''}
              {v.provisioned ? ` · ${t('provisioned')}` : ''}
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="rule-runs" className="mt-6">
        <h2 id="rule-runs" className="font-semibold text-text">
          {t('runs')}
        </h2>
        {wf.runs.length === 0 ? (
          <p className="mt-2 text-text-muted">{t('runsEmpty')}</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-2">
            {wf.runs.map((r) => (
              <li
                key={r.id}
                className="rounded-lg border border-border bg-surface p-3"
                data-run={r.status}
              >
                <span className="text-xs text-text-muted">
                  {format.dateTime(new Date(r.startedAt), WHEN)} ·{' '}
                  {t(
                    `triggers.${r.triggerType.includes('.') ? 'event' : (r.triggerType as 'event')}`,
                  )}
                  {r.customerId ? (
                    <>
                      {' · '}
                      <Link
                        href={`/customers/${r.customerId}${r.caseId ? `/cases/${r.caseId}` : ''}`}
                        className="text-brand-purple underline"
                      >
                        {t('openEntity')}
                      </Link>
                    </>
                  ) : null}
                </span>
                <RunExplanation explanation={r.explanation} status={r.status} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </Screen>
  );
}
