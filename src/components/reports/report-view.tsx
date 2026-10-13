'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { FormError, FormSuccess, type FormProblem } from '@/components/auth/form-message';
import { useAction } from '@/components/admin/use-action';
import { apiProblem } from '@/lib/api-problem';
import { postJSON } from '@/lib/post-json';
import { ExportButton } from './export-button';
import { ReportVisual, type Data, type Visual } from './report-visual';

// A saved report (6.2): its visual, drill-down on click, export, copy / edit / delete, and
// "Add to dashboard". One click each — no configuration needed to read it.

type Definition = Record<string, unknown> & { dimensions: unknown[] };
const BUILDER = 'builder';

export function DrillPanel({
  definition,
  row,
  onClose,
}: {
  definition: Definition;
  row: Record<string, string | null> | null;
  onClose: () => void;
}) {
  const t = useTranslations('reports.view');
  const tErrors = useTranslations('errors');
  const [items, setItems] = useState<{ id: string; label: string; href: string }[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [problem, setProblem] = useState<FormProblem | null>(null);
  const [loadedFor, setLoadedFor] = useState<unknown>(null);

  if (row && loadedFor !== row) {
    setLoadedFor(row);
    setItems(null);
    const values = Object.fromEntries(
      (definition.dimensions as unknown[]).map((_, i) => [`d${i}`, row[`d${i}`] ?? null]),
    );
    void postJSON('/api/reports/drill', { definition, values }).then((res) => {
      if (res.status === 200) {
        const body = res.json as {
          items: { id: string; label: string; href: string }[];
          truncated: boolean;
        };
        setItems(body.items);
        setTruncated(body.truncated);
      } else setProblem(apiProblem(res, tErrors));
    });
  }
  if (!row) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('drillTitle')}
      className="fixed inset-0 z-30 flex items-end justify-center bg-text/30 md:items-center"
      data-drill
    >
      <div className="max-h-[80dvh] w-full overflow-y-auto rounded-t-lg bg-surface p-4 md:max-w-lg md:rounded-lg">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-brand-green">{t('drillTitle')}</h2>
          <button
            type="button"
            className="min-h-11 px-3 text-sm text-brand-purple"
            onClick={onClose}
          >
            {t('close')}
          </button>
        </div>
        <FormError problem={problem} />
        <ul className="mt-2 flex flex-col">
          {(items ?? []).map((i) => (
            <li key={i.id}>
              <Link
                href={i.href}
                className="flex min-h-11 items-center border-b border-border text-sm text-brand-purple underline"
              >
                {i.label}
              </Link>
            </li>
          ))}
        </ul>
        {truncated ? <p className="mt-2 text-xs text-text-muted">{t('drillMore')}</p> : null}
      </div>
    </div>
  );
}

export function ReportView({
  id,
  definition,
  visual,
  data,
  mine,
  isSystem,
  canExport,
}: {
  id: string;
  definition: Definition;
  visual: Visual;
  data: Data;
  mine: boolean;
  isSystem: boolean;
  canExport: boolean;
}) {
  const t = useTranslations('reports.view');
  const router = useRouter();
  const [drillRow, setDrillRow] = useState<Record<string, string | null> | null>(null);
  const del = useAction();
  const dash = useAction();
  const secondary =
    'inline-flex min-h-11 items-center rounded-md border border-border bg-surface px-3 text-sm font-medium text-brand-purple';

  return (
    <div className="flex flex-col gap-3" data-report-view={id}>
      {isSystem ? <p className="text-sm text-text-muted">{t('system')}</p> : null}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={secondary} onClick={() => router.refresh()}>
          {t('refresh')}
        </button>
        <button
          type="button"
          className={secondary}
          data-add-to-dashboard
          onClick={() =>
            void dash.run('POST', '/api/dashboards/mine/widgets', { reportId: id }, t('added'))
          }
        >
          {t('addToDashboard')}
        </button>
        <Link href={`/reports/new?from=${id}`} className={secondary}>
          {t('copy')}
        </Link>
        {mine ? (
          <>
            <Link href={`/reports/${id}/edit`} className={secondary}>
              {t('edit')}
            </Link>
            <button
              type="button"
              className={secondary}
              onClick={async () => {
                if (await del.run('DELETE', `/api/report-definitions/${id}`, {}, t('deleted')))
                  router.push('/reports');
              }}
            >
              {t('delete')}
            </button>
          </>
        ) : null}
        {canExport ? <ExportButton type={BUILDER} filters={{ definition }} /> : null}
      </div>
      <FormError problem={del.problem ?? dash.problem} />
      <FormSuccess message={dash.notice} />
      <section className="rounded-lg border border-border bg-surface p-4">
        <ReportVisual data={data} visual={visual} onDrill={setDrillRow} />
      </section>
      <DrillPanel definition={definition} row={drillRow} onClose={() => setDrillRow(null)} />
    </div>
  );
}
