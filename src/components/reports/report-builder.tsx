'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';
import { FormError, FormSuccess, type FormProblem } from '@/components/auth/form-message';
import { apiProblem } from '@/lib/api-problem';
import { postJSON, sendJSON } from '@/lib/post-json';
import { DrillPanel } from './report-view';
import { ReportVisual, type Data, type Visual } from './report-visual';

// Report builder (6.2), mobile-compact: left the data and its fields (one click = group by /
// measure), filters as chips; right a live preview (table ↔ chart). Simple by default: a new
// report starts with "count" so the preview shows something at once.

type CatalogField = {
  key: string;
  kind: 'dimension' | 'measure' | 'both';
  type: string;
  label?: string;
};
type Catalog = { key: string; fields: CatalogField[] }[];
type Dim = { field: string; grain?: 'day' | 'week' | 'month' | 'quarter' | 'year' };
type Measure =
  | { field: string; agg: 'sum' | 'count' | 'avg' | 'min' | 'max'; fx: boolean }
  | { ratio: [number, number] };
type Filter = { field: string; op: string; value?: unknown };
type Spec = {
  dataset: string;
  dimensions: Dim[];
  measures: Measure[];
  filters: Filter[];
  sort: unknown[];
  limit: number;
};

const VISUALS: Visual[] = [
  'table',
  'bar',
  'stacked_bar',
  'line',
  'pie',
  'donut',
  'funnel',
  'kpi_number',
  'kpi_trend',
  'grouped_table',
];
const RELATIVE = [
  'today',
  'yesterday',
  'last_7_days',
  'last_30_days',
  'last_90_days',
  'this_month',
  'last_month',
  'this_quarter',
  'this_year',
  'last_year',
] as const;
const GRAINS = ['day', 'week', 'month', 'quarter', 'year'] as const;
const AGGS = ['sum', 'avg', 'min', 'max', 'count'] as const;
const VISIBILITIES = ['private', 'team', 'tenant'] as const;
const DEFAULT_GRAIN = 'month';
const TRUE = 'true';
const FALSE = 'false';
const field = 'min-h-11 rounded-md border border-border bg-surface px-3 text-sm text-text';
const chip =
  'inline-flex min-h-9 items-center gap-1 rounded-full border border-border bg-brand-purple-soft px-3 text-sm text-brand-purple';
const pick =
  'min-h-9 rounded-full border border-border px-3 text-sm text-text hover:bg-brand-purple-soft';

const opsFor = (type: string) =>
  type === 'date'
    ? ['relative', 'between', 'gte', 'lte', 'is_null', 'not_null']
    : type === 'number' || type === 'money'
      ? ['gt', 'gte', 'lt', 'lte', 'is_null', 'not_null']
      : type === 'bool'
        ? ['eq']
        : ['eq', 'ne', 'contains', 'is_null', 'not_null'];

export function ReportBuilder({
  catalog,
  initial,
  reportId,
  teams,
  canPublish,
}: {
  catalog: Catalog;
  initial: {
    name: string;
    definition: Spec;
    visual: Visual;
    visibility: 'private' | 'team' | 'tenant';
    teamId?: string;
  };
  reportId: string | null;
  teams: { id: string; name: string }[];
  canPublish: boolean;
}) {
  const t = useTranslations('reports');
  const tErrors = useTranslations('errors');
  const router = useRouter();
  const [spec, setSpec] = useState<Spec>(initial.definition);
  const [visual, setVisual] = useState<Visual>(initial.visual);
  const [name, setName] = useState(initial.name);
  const [visibility, setVisibility] = useState(initial.visibility);
  const [teamId, setTeamId] = useState(initial.teamId ?? teams[0]?.id ?? '');
  const [data, setData] = useState<Data | null>(null);
  const [problem, setProblem] = useState<FormProblem | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [drillRow, setDrillRow] = useState<Record<string, string | null> | null>(null);
  const [newFilter, setNewFilter] = useState<Filter | null>(null);

  const fields = useMemo(
    () => catalog.find((d) => d.key === spec.dataset)?.fields ?? [],
    [catalog, spec.dataset],
  );
  const label = (key: string) =>
    fields.find((f) => f.key === key)?.label ??
    (t.has(`fields.${key}` as 'fields.customer') ? t(`fields.${key}` as 'fields.customer') : key);
  const typeOf = (key: string) => fields.find((f) => f.key === key)?.type ?? 'text';

  // Live preview (debounced) on every change of the definition.
  const body = JSON.stringify(spec);
  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      void postJSON('/api/reports/run', { definition: JSON.parse(body) as Spec }).then((res) => {
        if (!live) return;
        if (res.status === 200) {
          setData(res.json as Data);
          setProblem(null);
        } else {
          setData(null);
          setProblem(apiProblem(res, tErrors));
        }
      });
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [body, tErrors]);

  const update = (p: Partial<Spec>) => setSpec((s) => ({ ...s, ...p }));
  const addDimension = (f: CatalogField) => {
    if (spec.dimensions.length >= 3 || spec.dimensions.some((d) => d.field === f.key)) return;
    update({
      dimensions: [
        ...spec.dimensions,
        f.type === 'date' ? { field: f.key, grain: 'month' } : { field: f.key },
      ],
    });
  };
  const addMeasure = (f: CatalogField) => {
    if (spec.measures.length >= 10) return;
    const m: Measure =
      f.key === 'count'
        ? { field: 'count', agg: 'count', fx: true }
        : { field: f.key, agg: 'sum', fx: true };
    update({ measures: [...spec.measures, m] });
  };

  async function save() {
    setBusy(true);
    setProblem(null);
    const payload = {
      name: name.trim() || t('builder.title'),
      definition: spec,
      visual,
      visibility,
      ...(visibility === 'team' ? { teamId } : {}),
    };
    const res = reportId
      ? await sendJSON('PUT', `/api/report-definitions/${reportId}`, payload)
      : await postJSON('/api/report-definitions', payload);
    setBusy(false);
    if (res.status === 200 || res.status === 201) {
      setNotice(t('builder.saved'));
      const id = (res.json as { id: string }).id;
      router.push(`/reports/${id}`);
    } else setProblem(apiProblem(res, tErrors));
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[22rem_1fr]" data-report-builder>
      <aside className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-4">
        <label className="flex flex-col gap-1 text-sm font-medium text-text">
          {t('builder.dataset')}
          <select
            className={field}
            value={spec.dataset}
            data-builder-dataset
            onChange={(e) =>
              setSpec({
                dataset: e.target.value,
                dimensions: [],
                measures: [{ field: 'count', agg: 'count', fx: true }],
                filters: [],
                sort: [],
                limit: 1000,
              })
            }
          >
            {catalog.map((d) => (
              <option key={d.key} value={d.key}>
                {t(`datasets.${d.key as 'invoices'}`)}
              </option>
            ))}
          </select>
        </label>

        <div>
          <p className="text-sm font-medium text-text">{t('builder.groupBy')}</p>
          <div className="mt-1 flex flex-wrap gap-1">
            {spec.dimensions.map((d, i) => (
              <span key={d.field} className={chip} data-dim={d.field}>
                {label(d.field)}
                {typeOf(d.field) === 'date' ? (
                  <select
                    aria-label={t('builder.grain')}
                    className="bg-transparent text-xs"
                    value={d.grain ?? DEFAULT_GRAIN}
                    onChange={(e) =>
                      update({
                        dimensions: spec.dimensions.map((x, j) =>
                          j === i ? { ...x, grain: e.target.value as Dim['grain'] } : x,
                        ) as Dim[],
                      })
                    }
                  >
                    {GRAINS.map((g) => (
                      <option key={g} value={g}>
                        {t(`grains.${g}`)}
                      </option>
                    ))}
                  </select>
                ) : null}
                <button
                  type="button"
                  aria-label={t('builder.remove')}
                  onClick={() => update({ dimensions: spec.dimensions.filter((_, j) => j !== i) })}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
          <p className="mt-2 text-xs text-text-muted">{t('builder.dimensionsHint')}</p>
          <div className="mt-1 flex flex-wrap gap-1" data-dim-options>
            {fields
              .filter((f) => f.kind !== 'measure' && f.key !== 'count')
              .map((f) => (
                <button
                  key={f.key}
                  type="button"
                  className={pick}
                  onClick={() => addDimension(f)}
                  data-add-dim={f.key}
                >
                  {label(f.key)}
                </button>
              ))}
          </div>
        </div>

        <div>
          <p className="text-sm font-medium text-text">{t('builder.measure')}</p>
          <div className="mt-1 flex flex-col gap-1">
            {spec.measures.map((m, i) => (
              <span
                key={i}
                className={`${chip} justify-between`}
                data-measure={'field' in m ? m.field : 'ratio'}
              >
                {'field' in m ? (
                  <>
                    <span>{label(m.field)}</span>
                    {m.field !== 'count' ? (
                      <select
                        aria-label={t('builder.measure')}
                        className="bg-transparent text-xs"
                        value={m.agg}
                        onChange={(e) =>
                          update({
                            measures: spec.measures.map((x, j) =>
                              j === i && 'field' in x ? { ...x, agg: e.target.value as 'sum' } : x,
                            ),
                          })
                        }
                      >
                        {AGGS.map((a) => (
                          <option key={a} value={a}>
                            {t(`aggs.${a}`)}
                          </option>
                        ))}
                      </select>
                    ) : null}
                    {typeOf(m.field) === 'money' ? (
                      <label className="flex items-center gap-1 text-xs">
                        <input
                          type="checkbox"
                          checked={m.fx}
                          onChange={(e) =>
                            update({
                              measures: spec.measures.map((x, j) =>
                                j === i && 'field' in x ? { ...x, fx: e.target.checked } : x,
                              ),
                            })
                          }
                        />
                        {t('builder.fx')}
                      </label>
                    ) : null}
                  </>
                ) : (
                  <span>{t('ratio')}</span>
                )}
                <button
                  type="button"
                  aria-label={t('builder.remove')}
                  onClick={() => update({ measures: spec.measures.filter((_, j) => j !== i) })}
                  disabled={spec.measures.length === 1}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
          <p className="mt-2 text-xs text-text-muted">{t('builder.measuresHint')}</p>
          <div className="mt-1 flex flex-wrap gap-1">
            {fields
              .filter((f) => f.kind !== 'dimension' && (f.type === 'money' || f.type === 'number'))
              .map((f) => (
                <button
                  key={f.key}
                  type="button"
                  className={pick}
                  onClick={() => addMeasure(f)}
                  data-add-measure={f.key}
                >
                  {label(f.key)}
                </button>
              ))}
            {spec.measures.length >= 2 && !spec.measures.some((m) => 'ratio' in m) ? (
              <button
                type="button"
                className={pick}
                onClick={() => update({ measures: [...spec.measures, { ratio: [0, 1] }] })}
              >
                {t('builder.addRatio')}
              </button>
            ) : null}
          </div>
        </div>

        <div>
          <p className="text-sm font-medium text-text">{t('builder.filters')}</p>
          <div className="mt-1 flex flex-wrap gap-1">
            {spec.filters.map((f, i) => (
              <span key={i} className={chip} data-filter={f.field}>
                {label(f.field)} {t(`ops.${f.op as 'eq'}`)}{' '}
                {f.op === 'relative'
                  ? t(`relative.${String(f.value) as 'today'}`)
                  : Array.isArray(f.value)
                    ? f.value.join(' – ')
                    : f.value === true
                      ? t('yes')
                      : f.value === false
                        ? t('no')
                        : String(f.value ?? '')}
                <button
                  type="button"
                  aria-label={t('builder.remove')}
                  onClick={() => update({ filters: spec.filters.filter((_, j) => j !== i) })}
                >
                  ×
                </button>
              </span>
            ))}
            <button
              type="button"
              className={pick}
              data-add-filter
              onClick={() =>
                setNewFilter({
                  field: fields.find((f) => f.kind !== 'measure')?.key ?? 'customer',
                  op: 'eq',
                  value: '',
                })
              }
            >
              {t('builder.addFilter')}
            </button>
          </div>
          {newFilter ? (
            <div
              className="mt-2 flex flex-col gap-2 rounded-md border border-border p-2"
              data-filter-editor
            >
              <select
                className={field}
                value={newFilter.field}
                onChange={(e) => {
                  const ty = typeOf(e.target.value);
                  setNewFilter({
                    field: e.target.value,
                    op: opsFor(ty)[0] ?? 'eq',
                    value: ty === 'bool' ? true : ty === 'date' ? 'last_30_days' : '',
                  });
                }}
              >
                {fields
                  .filter((f) => f.key !== 'count')
                  .map((f) => (
                    <option key={f.key} value={f.key}>
                      {label(f.key)}
                    </option>
                  ))}
              </select>
              <select
                className={field}
                value={newFilter.op}
                onChange={(e) => setNewFilter({ ...newFilter, op: e.target.value })}
              >
                {opsFor(typeOf(newFilter.field)).map((o) => (
                  <option key={o} value={o}>
                    {t(`ops.${o as 'eq'}`)}
                  </option>
                ))}
              </select>
              {newFilter.op === 'relative' ? (
                <select
                  className={field}
                  value={String(newFilter.value)}
                  onChange={(e) => setNewFilter({ ...newFilter, value: e.target.value })}
                >
                  {RELATIVE.map((r) => (
                    <option key={r} value={r}>
                      {t(`relative.${r}`)}
                    </option>
                  ))}
                </select>
              ) : typeOf(newFilter.field) === 'bool' ? (
                <select
                  className={field}
                  value={String(newFilter.value)}
                  onChange={(e) => setNewFilter({ ...newFilter, value: e.target.value === 'true' })}
                >
                  <option value={TRUE}>{t('yes')}</option>
                  <option value={FALSE}>{t('no')}</option>
                </select>
              ) : newFilter.op === 'between' ? (
                <div className="flex gap-2">
                  {[0, 1].map((k) => (
                    <input
                      key={k}
                      type="date"
                      className={field}
                      onChange={(e) => {
                        const v = Array.isArray(newFilter.value)
                          ? [...(newFilter.value as string[])]
                          : ['', ''];
                        v[k] = e.target.value;
                        setNewFilter({ ...newFilter, value: v });
                      }}
                    />
                  ))}
                </div>
              ) : newFilter.op === 'is_null' || newFilter.op === 'not_null' ? null : (
                <input
                  className={field}
                  type={typeOf(newFilter.field) === 'date' ? 'date' : 'text'}
                  aria-label={t('builder.value')}
                  value={String(newFilter.value ?? '')}
                  onChange={(e) => setNewFilter({ ...newFilter, value: e.target.value })}
                />
              )}
              <button
                type="button"
                className="min-h-11 rounded-md bg-brand-green px-4 text-sm font-medium text-surface"
                onClick={() => {
                  const f = { ...newFilter };
                  if (f.op === 'is_null' || f.op === 'not_null') delete f.value;
                  update({ filters: [...spec.filters, f] });
                  setNewFilter(null);
                }}
              >
                {t('builder.apply')}
              </button>
            </div>
          ) : null}
        </div>

        <div className="flex flex-col gap-2 border-t border-border pt-4">
          <label className="flex flex-col gap-1 text-sm font-medium text-text">
            {t('builder.name')}
            <input
              className={field}
              value={name}
              maxLength={120}
              onChange={(e) => setName(e.target.value)}
              data-builder-name
            />
          </label>
          {canPublish ? (
            <label className="flex flex-col gap-1 text-sm font-medium text-text">
              {t('builder.visibility')}
              <select
                className={field}
                value={visibility}
                onChange={(e) => setVisibility(e.target.value as 'private')}
              >
                {VISIBILITIES.filter((v) => v !== 'team' || teams.length > 0).map((v) => (
                  <option key={v} value={v}>
                    {t(`builder.visibilities.${v}`)}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {visibility === 'team' ? (
            <select
              className={field}
              aria-label={t('builder.team')}
              value={teamId}
              onChange={(e) => setTeamId(e.target.value)}
            >
              {teams.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          ) : null}
          <button
            type="button"
            className="min-h-11 rounded-md bg-brand-green px-4 font-medium text-surface disabled:opacity-60"
            disabled={busy}
            onClick={() => void save()}
            data-builder-save
          >
            {t('builder.save')}
          </button>
          <FormSuccess message={notice} />
        </div>
      </aside>

      <section
        className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-surface p-4"
        data-builder-preview
      >
        <div className="flex flex-wrap gap-1" role="group" aria-label={t('builder.visual')}>
          {VISUALS.map((v) => (
            <button
              key={v}
              type="button"
              className={`${pick} ${visual === v ? 'bg-brand-purple-soft font-medium text-brand-purple' : ''}`}
              aria-pressed={visual === v}
              onClick={() => setVisual(v)}
              data-visual-pick={v}
            >
              {t(`visuals.${v}`)}
            </button>
          ))}
        </div>
        <FormError problem={problem} />
        {data ? (
          <>
            <ReportVisual data={data} visual={visual} onDrill={setDrillRow} />
            {data.truncated ? (
              <p className="text-xs text-text-muted">{t('builder.truncated')}</p>
            ) : null}
          </>
        ) : problem ? null : (
          <p className="text-sm text-text-muted">{t('builder.loading')}</p>
        )}
      </section>
      <DrillPanel
        definition={spec as unknown as Record<string, unknown> & { dimensions: unknown[] }}
        row={drillRow}
        onClose={() => setDrillRow(null)}
      />
    </div>
  );
}
