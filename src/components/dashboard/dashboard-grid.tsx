'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState, type ReactNode } from 'react';
import { FormError, FormSuccess } from '@/components/auth/form-message';
import { useAction } from '@/components/admin/use-action';
import { DrillPanel } from '@/components/reports/report-view';
import { ReportVisual, type Data, type Visual } from '@/components/reports/report-visual';

// Dashboard (6.3): a 12-column grid on desktop, a list on a phone. Reading needs no setup; "Edit"
// (own dashboards) shows size / remove / move per widget — drag on desktop, ↑ ↓ on a phone — and
// "Add widget" (a saved report or a system widget). The system dashboard is copied to change it.

type Item = {
  id: string;
  size: 3 | 4 | 6 | 8 | 12;
  title: string | null;
  kind: string;
  body: ReactNode;
};
type DashboardOption = { id: string; name: string; isSystem: boolean; mine: boolean };
type ReportOption = { id: string; name: string };

const SPAN: Record<number, string> = {
  3: 'lg:col-span-3',
  4: 'lg:col-span-4',
  6: 'lg:col-span-6',
  8: 'lg:col-span-8',
  12: 'lg:col-span-12',
};
const SIZES = [3, 4, 6, 8, 12] as const;
const SYSTEM_WIDGETS = ['attention', 'my_tasks', 'team_attention', 'aging'] as const;
const KPIS = [
  'overdue_total',
  'open_total',
  'dso',
  'promises_today',
  'promises_broken',
  'disputed',
  'open_cases',
  'collected_30',
  'collection_rate',
] as const;
const btn =
  'inline-flex min-h-11 items-center rounded-md border border-border bg-surface px-3 text-sm font-medium text-brand-purple disabled:opacity-60';
const field = 'min-h-11 rounded-md border border-border bg-surface px-3 text-sm text-text';

export function ReportWidget({
  data,
  visual,
  definition,
}: {
  data: Data;
  visual: Visual;
  definition: Record<string, unknown> & { dimensions: unknown[] };
}) {
  const [row, setRow] = useState<Record<string, string | null> | null>(null);
  return (
    <>
      <ReportVisual data={data} visual={visual} onDrill={setRow} />
      <DrillPanel definition={definition} row={row} onClose={() => setRow(null)} />
    </>
  );
}

export function DashboardGrid({
  dashboard,
  dashboards,
  items,
  reports,
  cachedAt,
}: {
  dashboard: DashboardOption;
  dashboards: DashboardOption[];
  items: Item[];
  reports: ReportOption[];
  cachedAt: string;
}) {
  const t = useTranslations('dashboards');
  const router = useRouter();
  const act = useAction();
  const [editing, setEditing] = useState(false);
  const [order, setOrder] = useState(items.map((i) => i.id));
  const [dragging, setDragging] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const byId = new Map(items.map((i) => [i.id, i]));
  const ordered = order.map((id) => byId.get(id)).filter((i): i is Item => Boolean(i));
  const base = `/api/dashboards/${dashboard.id}`;

  async function saveOrder(next: string[]) {
    setOrder(next);
    await act.run('PUT', `${base}/order`, { widgetIds: next }, t('saved'));
  }
  const move = (id: string, by: number) => {
    const i = order.indexOf(id);
    const j = i + by;
    if (i < 0 || j < 0 || j >= order.length) return;
    const next = [...order];
    [next[i], next[j]] = [next[j] as string, next[i] as string];
    void saveOrder(next);
  };

  return (
    <div
      className="flex flex-col gap-3"
      data-dashboard={dashboard.id}
      data-dashboard-system={dashboard.isSystem ? '1' : '0'}
    >
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-sm font-medium text-text">
          {t('choose')}
          <select
            className={field}
            value={dashboard.id}
            onChange={(e) => router.push(`/?d=${e.target.value}`)}
            data-dashboard-switch
          >
            {dashboards.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        <Link href={`/?d=${dashboard.id}&refresh=1`} className={btn} data-dashboard-refresh>
          {t('refresh')}
        </Link>
        {dashboard.mine ? (
          <button
            type="button"
            className={btn}
            onClick={() => setEditing((e) => !e)}
            data-dashboard-edit
            aria-pressed={editing}
          >
            {editing ? t('done') : t('edit')}
          </button>
        ) : (
          <button
            type="button"
            className={btn}
            data-dashboard-copy
            onClick={async () => {
              if (await act.run('POST', `${base}/copy`, {}, t('copied'))) router.push('/');
            }}
          >
            {t('copy')}
          </button>
        )}
        <button
          type="button"
          className={btn}
          onClick={() => void act.run('POST', `${base}/home`, {}, t('homeSet'))}
        >
          {t('makeHome')}
        </button>
        <span className="text-xs text-text-muted">{t('cachedAt', { time: cachedAt })}</span>
      </div>
      <FormError problem={act.problem} />
      <FormSuccess message={act.notice} />

      {editing ? (
        <div className="rounded-lg border border-border bg-surface p-3" data-widget-add>
          <button type="button" className={btn} onClick={() => setAdding((a) => !a)}>
            {t('addWidget')}
          </button>
          {adding ? (
            <div className="mt-3 flex flex-col gap-3">
              <div>
                <p className="text-sm font-medium text-text">{t('fromReport')}</p>
                {reports.length === 0 ? (
                  <p className="text-sm text-text-muted">{t('noReports')}</p>
                ) : (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {reports.map((r) => (
                      <button
                        key={r.id}
                        type="button"
                        className="min-h-9 rounded-full border border-border px-3 text-sm text-text hover:bg-brand-purple-soft"
                        onClick={() =>
                          void act.run(
                            'POST',
                            `${base}/widgets`,
                            { kind: 'report', reportId: r.id },
                            t('added'),
                          )
                        }
                        data-add-report={r.id}
                      >
                        {r.name}
                      </button>
                    ))}
                  </div>
                )}
                <Link
                  href="/reports/new"
                  className="mt-1 inline-block text-sm text-brand-purple underline"
                >
                  {t('newReport')}
                </Link>
              </div>
              <div>
                <p className="text-sm font-medium text-text">{t('systemWidgets')}</p>
                <div className="mt-1 flex flex-wrap gap-1">
                  {SYSTEM_WIDGETS.map((k) => (
                    <button
                      key={k}
                      type="button"
                      className="min-h-9 rounded-full border border-border px-3 text-sm text-text hover:bg-brand-purple-soft"
                      onClick={() =>
                        void act.run(
                          'POST',
                          `${base}/widgets`,
                          { kind: k, size: k === 'attention' ? 12 : 6 },
                          t('added'),
                        )
                      }
                    >
                      {t(`kinds.${k}`)}
                    </button>
                  ))}
                  {KPIS.map((k) => (
                    <button
                      key={k}
                      type="button"
                      className="min-h-9 rounded-full border border-border px-3 text-sm text-text hover:bg-brand-purple-soft"
                      onClick={() =>
                        void act.run(
                          'POST',
                          `${base}/widgets`,
                          { kind: 'kpi', kpiKey: k, size: 4 },
                          t('added'),
                        )
                      }
                    >
                      {t(`kpis.${k}`)}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {ordered.length === 0 ? (
        <section className="rounded-lg border border-border bg-surface p-6 text-center">
          <p className="font-semibold text-brand-green">{t('emptyTitle')}</p>
          <p className="mx-auto mt-1 max-w-prose text-sm text-text-muted">
            {t('emptyDescription')}
          </p>
        </section>
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-12">
          {ordered.map((item, i) => (
            <div
              key={item.id}
              className={`flex min-w-0 flex-col ${SPAN[item.size] ?? 'lg:col-span-6'} ${dragging === item.id ? 'opacity-50' : ''}`}
              data-widget={item.kind}
              draggable={editing}
              onDragStart={() => setDragging(item.id)}
              onDragEnd={() => setDragging(null)}
              onDragOver={(e) => editing && e.preventDefault()}
              onDrop={() => {
                if (!dragging || dragging === item.id) return;
                const next = order.filter((x) => x !== dragging);
                next.splice(next.indexOf(item.id), 0, dragging);
                setDragging(null);
                void saveOrder(next);
              }}
            >
              {editing ? (
                <div className="mb-1 flex flex-wrap items-center gap-1 text-xs" data-widget-tools>
                  <button
                    type="button"
                    className={btn}
                    aria-label={t('up')}
                    disabled={i === 0}
                    onClick={() => move(item.id, -1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className={btn}
                    aria-label={t('down')}
                    disabled={i === ordered.length - 1}
                    onClick={() => move(item.id, 1)}
                  >
                    ↓
                  </button>
                  <select
                    className={field}
                    aria-label={t('size')}
                    defaultValue={item.size}
                    onChange={(e) =>
                      void act.run(
                        'PUT',
                        `${base}/widgets/${item.id}`,
                        { size: Number(e.target.value) },
                        t('saved'),
                      )
                    }
                  >
                    {SIZES.map((s) => (
                      <option key={s} value={s}>
                        {t(`sizes.${s}`)}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className={btn}
                    onClick={() =>
                      void act.run('DELETE', `${base}/widgets/${item.id}`, {}, t('removed'))
                    }
                  >
                    {t('remove')}
                  </button>
                </div>
              ) : null}
              {item.body}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
