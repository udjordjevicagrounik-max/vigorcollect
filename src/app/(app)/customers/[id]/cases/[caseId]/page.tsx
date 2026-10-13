import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { z } from 'zod';
import { ForbiddenState } from '@/components/admin/forbidden-state';
import { CaseActions } from '@/components/receivables/case-actions';
import { CustomerActions } from '@/components/receivables/customer-actions';
import { RunExplanation } from '@/components/rules/run-explanation';
import { Screen } from '@/components/shell/screen';
import { formatAmount } from '@/lib/format-amount';
import { PermissionDeniedError, permissionKeys } from '@/server/auth/permissions';
import { NotFoundError, withTenantPage } from '@/server/auth/with-tenant';
import { getCase, localToday } from '@/server/collections/service';
import { codeLabels } from '@/server/receivables/service';
import { getValues, listDefinitions } from '@/server/custom-fields/service';
import { CustomFieldsPanel } from '@/components/custom-fields/fields-panel';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.uuid(), caseId: z.uuid() });
const WHEN = { dateStyle: 'medium', timeStyle: 'short' } as const;

// Case screen (task 2.4, wireframe docs/wireframes/case.html), mobile-compact: stage, owner,
// priority, invoices, promise / activity on the case, legal handover, timeline (domain events +
// activities).
const CF_CASE = 'case' as const;

export default async function CasePage({
  params,
}: {
  params: Promise<{ id: string; caseId: string }>;
}) {
  const parsed = paramsSchema.safeParse(await params);
  if (!parsed.success) notFound();
  const locale = await getLocale();
  let data;
  try {
    data = await withTenantPage(async (ctx) => {
      const detail = await getCase(ctx, parsed.data.caseId);
      if (detail.customerId !== parsed.data.id) throw new NotFoundError();
      const keys = await permissionKeys(ctx.db, ctx.userId);
      return {
        detail,
        keys: [...keys],
        today: (await localToday(ctx.db)).today,
        currency:
          (await ctx.db.query<{ c: string }>('SELECT default_currency AS c FROM tenant_settings'))
            .rows[0]?.c ?? 'EUR',
        stages: await codeLabels(ctx, 'case_stage', locale),
        outcomes: await codeLabels(ctx, 'activity_outcome', locale),
        nextActions: await codeLabels(ctx, 'next_action', locale),
        // 6.1: additional fields of the case.
        cfDefs: await listDefinitions(ctx, { entityType: 'case', locale }),
        cfValues: await getValues(ctx, 'case', parsed.data.caseId),
      };
    });
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    if (error instanceof PermissionDeniedError) return <ForbiddenState />;
    throw error;
  }
  const t = await getTranslations('collections.caseScreen');
  const format = await getFormatter();
  const d = data.detail;
  const open = d.status === 'open';
  return (
    <Screen mobileClass="mobile-compact">
      <header className="mb-4">
        <p className="text-sm">
          <Link
            href={`/customers/${d.customerId}?tab=cases`}
            className="text-brand-purple underline"
          >
            ← {d.customerName ?? t('naturalPerson')}
          </Link>
        </p>
        <h1 className="mt-1 text-xl font-semibold text-brand-green" data-case-title>
          {t('title', { stage: data.stages[d.stage] ?? d.stage })}
        </h1>
        <span aria-hidden="true" className="mt-2 block h-[3px] w-12 bg-brand-gold" />
        <p className="mt-2 text-sm text-text-muted" data-case-status={d.status}>
          {t(`status.${d.status as 'open'}`)} · {t(`priorities.${d.priority as 'normal'}`)} ·{' '}
          {d.ownerName ?? t('noOwner')} ·{' '}
          {t('opened', { date: format.dateTime(new Date(d.openedAt), WHEN) })}
        </p>
      </header>

      <div className="mb-4">
        <CustomFieldsPanel
          entity={CF_CASE}
          entityId={d.id}
          fields={data.cfDefs}
          values={data.cfValues}
          canEdit={data.keys.includes('case.update')}
          defaultCurrency={data.currency}
        />
      </div>

      {open ? (
        <CaseActions
          caseId={d.id}
          stage={d.stage}
          priority={d.priority}
          stages={data.stages}
          canUpdate={data.keys.includes('case.update')}
          canHandover={data.keys.includes('approval.create') && data.keys.includes('case.update')}
          legalPending={d.legalPending}
        />
      ) : null}

      <section
        aria-labelledby="case-invoices"
        className="mt-4 rounded-lg border border-border bg-surface p-4"
      >
        <h2 id="case-invoices" className="font-semibold text-text">
          {t('invoices', { n: d.invoices.length })}
        </h2>
        <ul className="mt-2 flex flex-col gap-1 text-sm">
          {d.invoices.map((i) => (
            <li
              key={i.id}
              className="flex flex-wrap justify-between gap-2"
              data-case-invoice={i.id}
            >
              <span className="text-text">
                {i.number} · {t('due', { date: i.dueDate })}
              </span>
              <span className="font-medium text-text">
                {formatAmount(i.amountOpen, i.currency, locale)}
                {i.daysOverdue ? ` · ${t('days', { n: i.daysOverdue })}` : ''}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {open ? (
        <CustomerActions
          customerId={d.customerId}
          caseId={d.id}
          currency={d.invoices[0]?.currency ?? data.currency}
          today={data.today}
          permissions={data.keys}
          openInvoices={[]}
          outcomes={data.outcomes}
          nextActions={data.nextActions}
        />
      ) : null}

      <section aria-labelledby="case-timeline" className="mt-4">
        <h2 id="case-timeline" className="font-semibold text-text">
          {t('timeline')}
        </h2>
        {d.timeline.length === 0 ? (
          <p className="mt-2 text-text-muted">{t('timelineEmpty')}</p>
        ) : (
          <ol className="mt-2 flex flex-col gap-2 border-l-2 border-brand-purple-soft pl-4">
            {d.timeline.map((e, i) => (
              <li
                key={`${e.at}-${i}`}
                className="text-sm"
                data-timeline={e.kind === 'run' ? 'workflow.run' : e.type}
              >
                <span className="text-text-muted">{format.dateTime(new Date(e.at), WHEN)}</span>{' '}
                {e.kind === 'run' ? <RunExplanation explanation={e.data} status={e.type} /> : null}
                {e.kind !== 'run' ? (
                  <span className="font-medium text-text">
                    {t.has(`events.${e.type as 'case.opened'}`)
                      ? t(`events.${e.type as 'case.opened'}`)
                      : e.type}
                  </span>
                ) : null}
                {e.actorName ? <span className="text-text-muted"> · {e.actorName}</span> : null}
                {e.kind === 'activity' && typeof e.data.outcome === 'string' ? (
                  <span className="block text-text-muted">
                    {data.outcomes[e.data.outcome] ?? e.data.outcome}
                  </span>
                ) : null}
                {e.type === 'case.stage_changed' && typeof e.data.to === 'string' ? (
                  <span className="block text-text-muted">
                    → {data.stages[e.data.to] ?? e.data.to}
                  </span>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </section>
    </Screen>
  );
}
