'use client';

import { useLocale, useTranslations } from 'next-intl';
import { delta, shares, sumDecimals } from '@/lib/chart-scale';
import { formatAmount } from '@/lib/format-amount';

// Report visuals (6.2) — our own SVG, no chart package. Series colors are tokens (chart-1 purple,
// chart-2 green, chart-3 grey, …); red is never used for neutral data. Every bar / row is a
// button: a click opens the drill-down of that row. Values stay decimal strings (rule 18).

export type Column = {
  id: string;
  field: string;
  role: 'dimension' | 'measure';
  type: string;
  agg?: string;
  grain?: string;
  codeList?: string;
  currency?: string;
  label?: string;
};
export type Data = {
  columns: Column[];
  rows: Record<string, string | null>[];
  currency: string;
  truncated: boolean;
  labels: Record<string, Record<string, string>>;
};
export type Visual =
  | 'table'
  | 'bar'
  | 'stacked_bar'
  | 'line'
  | 'pie'
  | 'donut'
  | 'funnel'
  | 'kpi_number'
  | 'kpi_trend'
  | 'grouped_table';

const SERIES = [1, 2, 3, 4, 5, 6].map((i) => `var(--color-chart-${i})`);
const color = (i: number) => SERIES[i % SERIES.length] ?? SERIES[0];

export function useFormatters(data: Data) {
  const t = useTranslations('reports');
  const locale = useLocale();
  const columnLabel = (c: Column) => {
    const base =
      c.label ??
      (t.has(`fields.${c.field}` as 'fields.customer')
        ? t(`fields.${c.field}` as 'fields.customer')
        : c.field);
    if (c.role === 'measure' && c.agg && c.agg !== 'count' && c.field !== 'ratio')
      return `${base} (${t(`aggs.${c.agg as 'sum'}`)})`;
    if (c.field === 'ratio') return t('ratio');
    if (c.agg === 'count' && c.field === 'count') return t('fields.count');
    return base;
  };
  const value = (c: Column, v: string | null | undefined) => {
    if (v === null || v === undefined) return '—';
    if (c.role === 'measure') {
      if (c.type === 'money') return formatAmount(v, c.currency ?? data.currency, locale);
      if (c.type === 'percent') return `${v} %`;
      try {
        return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(
          v as Intl.StringNumericLiteral,
        );
      } catch {
        return v;
      }
    }
    if (c.codeList) return data.labels[c.codeList]?.[v] ?? v;
    if (c.type === 'bool') return v === 'true' ? t('yes') : t('no');
    if (c.type === 'code' && t.has(`values.${v}` as 'values.open'))
      return t(`values.${v}` as 'values.open');
    if (c.type === 'date' && c.grain === 'month') return v.slice(0, 7);
    if (c.type === 'date' && c.grain === 'year') return v.slice(0, 4);
    return v;
  };
  return { columnLabel, value };
}

type Props = { data: Data; visual: Visual; onDrill?: (row: Record<string, string | null>) => void };

export function ReportVisual({ data, visual, onDrill }: Props) {
  const t = useTranslations('reports');
  const f = useFormatters(data);
  const dims = data.columns.filter((c) => c.role === 'dimension');
  const measures = data.columns.filter((c) => c.role === 'measure');
  const m0 = measures[0];
  if (data.rows.length === 0)
    return (
      <p className="py-6 text-sm text-text-muted" data-report-empty>
        {t('empty')}
      </p>
    );
  if (!m0) return null;
  const d0 = dims[0];
  const d1 = dims[1];

  if (visual === 'kpi_number') {
    const total = sumDecimals(data.rows.map((r) => r[m0.id]));
    return (
      <div className="py-4" data-visual="kpi_number">
        <p className="text-sm text-text-muted">{f.columnLabel(m0)}</p>
        <p className="text-3xl font-semibold text-brand-green">{f.value(m0, total)}</p>
      </div>
    );
  }

  if (visual === 'kpi_trend' && d0) {
    const ordered = [...data.rows].sort((a, b) => String(a[d0.id]).localeCompare(String(b[d0.id])));
    const last = ordered[ordered.length - 1]?.[m0.id] ?? null;
    const prev = ordered[ordered.length - 2]?.[m0.id] ?? null;
    const ch = delta(last, prev);
    const s = shares(ordered.map((r) => r[m0.id]));
    const points = s
      .map((v, i) => `${(i / Math.max(1, s.length - 1)) * 100},${30 - v * 28}`)
      .join(' ');
    return (
      <div className="py-4" data-visual="kpi_trend">
        <p className="text-sm text-text-muted">{f.columnLabel(m0)}</p>
        <p className="text-3xl font-semibold text-brand-green">{f.value(m0, last)}</p>
        {ch.percent ? (
          <p className="text-sm text-text-muted">{t('trend', { percent: ch.percent })}</p>
        ) : null}
        <svg
          viewBox="0 0 100 32"
          className="mt-2 h-10 w-full"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <polyline
            points={points}
            fill="none"
            stroke={color(0)}
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      </div>
    );
  }

  if ((visual === 'pie' || visual === 'donut') && d0) {
    const s = shares(data.rows.map((r) => r[m0.id]));
    const total = s.reduce((a, b) => a + b, 0) || 1;
    const starts = s.map(
      (_, i) => -Math.PI / 2 + (s.slice(0, i).reduce((a, b) => a + b, 0) / total) * Math.PI * 2,
    );
    const arcs = s.map((v, i) => {
      const a0 = starts[i] ?? 0;
      const a1 = a0 + (v / total) * Math.PI * 2;
      const large = a1 - a0 > Math.PI ? 1 : 0;
      const p = (a: number, r: number) => `${50 + r * Math.cos(a)} ${50 + r * Math.sin(a)}`;
      const inner = visual === 'donut' ? 26 : 0;
      const d =
        inner > 0
          ? `M ${p(a0, 48)} A 48 48 0 ${large} 1 ${p(a1, 48)} L ${p(a1, inner)} A ${inner} ${inner} 0 ${large} 0 ${p(a0, inner)} Z`
          : `M 50 50 L ${p(a0, 48)} A 48 48 0 ${large} 1 ${p(a1, 48)} Z`;
      return { d, i };
    });
    return (
      <div className="flex flex-col gap-4 md:flex-row md:items-center" data-visual={visual}>
        <svg
          viewBox="0 0 100 100"
          className="mx-auto h-48 w-48 shrink-0"
          role="img"
          aria-label={f.columnLabel(m0)}
        >
          {arcs.map((a) => (
            <path
              key={a.i}
              d={a.d}
              fill={color(a.i)}
              className={onDrill ? 'cursor-pointer' : ''}
              onClick={() => {
                const row = data.rows[a.i];
                if (row) onDrill?.(row);
              }}
            />
          ))}
        </svg>
        <Legend data={data} dim={d0} measure={m0} onDrill={onDrill} />
      </div>
    );
  }

  if ((visual === 'bar' || visual === 'funnel' || visual === 'line') && d0) {
    let rows = data.rows;
    if (visual === 'funnel' && d0.codeList && data.labels[d0.codeList]) {
      const order = Object.keys(data.labels[d0.codeList] ?? {});
      rows = [...rows].sort(
        (a, b) => order.indexOf(String(a[d0.id])) - order.indexOf(String(b[d0.id])),
      );
    }
    if (visual === 'line')
      rows = [...rows].sort((a, b) => String(a[d0.id]).localeCompare(String(b[d0.id])));
    const series =
      visual === 'funnel' ? [m0] : measures.filter((m) => m.type !== 'percent').slice(0, 3);
    const all = shares(rows.flatMap((r) => series.map((m) => r[m.id])));
    if (visual === 'line') {
      return (
        <div data-visual="line">
          <svg
            viewBox="0 0 100 40"
            className="h-48 w-full"
            preserveAspectRatio="none"
            role="img"
            aria-label={f.columnLabel(m0)}
          >
            {series.map((m, si) => (
              <polyline
                key={m.id}
                fill="none"
                stroke={color(si)}
                strokeWidth="2"
                vectorEffect="non-scaling-stroke"
                points={rows
                  .map(
                    (_, i) =>
                      `${(i / Math.max(1, rows.length - 1)) * 100},${38 - (all[i * series.length + si] ?? 0) * 36}`,
                  )
                  .join(' ')}
              />
            ))}
          </svg>
          <div className="mt-1 flex justify-between text-xs text-text-muted">
            <span>{f.value(d0, rows[0]?.[d0.id])}</span>
            <span>{f.value(d0, rows[rows.length - 1]?.[d0.id])}</span>
          </div>
          <SeriesLegend data={data} series={series} />
        </div>
      );
    }
    return (
      <div className="flex flex-col gap-2" data-visual={visual}>
        {rows.map((r, i) => (
          <button
            key={`${r[d0.id]}-${i}`}
            type="button"
            className="grid min-h-11 grid-cols-[minmax(0,9rem)_1fr] items-center gap-2 text-left text-sm md:grid-cols-[14rem_1fr]"
            onClick={() => onDrill?.(r)}
            data-drill-row={i}
          >
            <span className="truncate text-text">{f.value(d0, r[d0.id])}</span>
            <span className={`flex flex-col gap-1 ${visual === 'funnel' ? 'items-center' : ''}`}>
              {series.map((m, si) => {
                const share = all[i * series.length + si] ?? 0;
                return (
                  <span key={m.id} className="flex w-full items-center gap-2">
                    <span
                      className={`block h-4 rounded-sm ${visual === 'funnel' ? 'mx-auto' : ''}`}
                      style={{
                        width: `${Math.max(1, share * 100) * (visual === 'funnel' ? 1 : 0.7)}%`,
                        background: color(si),
                      }}
                    />
                    <span className="shrink-0 text-xs text-text-muted">{f.value(m, r[m.id])}</span>
                  </span>
                );
              })}
            </span>
          </button>
        ))}
        {series.length > 1 ? <SeriesLegend data={data} series={series} /> : null}
      </div>
    );
  }

  if (visual === 'stacked_bar' && d0 && d1) {
    const groups = [...new Set(data.rows.map((r) => r[d0.id] ?? ''))];
    const stacks = [...new Set(data.rows.map((r) => r[d1.id] ?? ''))];
    const totals = groups.map((g) =>
      sumDecimals(data.rows.filter((r) => (r[d0.id] ?? '') === g).map((r) => r[m0.id])),
    );
    const width = shares(totals);
    return (
      <div className="flex flex-col gap-2" data-visual="stacked_bar">
        {groups.map((g, gi) => {
          const parts = stacks.map((st) =>
            data.rows.find((r) => (r[d0.id] ?? '') === g && (r[d1.id] ?? '') === st),
          );
          const ps = shares(parts.map((p) => p?.[m0.id] ?? '0'));
          const sum = ps.reduce((a, b) => a + b, 0) || 1;
          return (
            <div
              key={g}
              className="grid min-h-11 grid-cols-[minmax(0,9rem)_1fr] items-center gap-2 text-sm md:grid-cols-[14rem_1fr]"
            >
              <span className="truncate text-text">{f.value(d0, g)}</span>
              <span className="flex items-center gap-2">
                <span
                  className="flex h-4 overflow-hidden rounded-sm"
                  style={{ width: `${Math.max(1, (width[gi] ?? 0) * 70)}%` }}
                >
                  {parts.map((p, si) =>
                    p ? (
                      <button
                        key={si}
                        type="button"
                        aria-label={`${f.value(d1, stacks[si])}: ${f.value(m0, p[m0.id])}`}
                        className="h-4"
                        style={{ width: `${((ps[si] ?? 0) / sum) * 100}%`, background: color(si) }}
                        onClick={() => onDrill?.(p)}
                      />
                    ) : null,
                  )}
                </span>
                <span className="shrink-0 text-xs text-text-muted">{f.value(m0, totals[gi])}</span>
              </span>
            </div>
          );
        })}
        <div className="flex flex-wrap gap-3 text-xs text-text-muted">
          {stacks.map((st, si) => (
            <span key={st} className="flex items-center gap-1">
              <span className="block size-3 rounded-sm" style={{ background: color(si) }} />
              {f.value(d1, st)}
            </span>
          ))}
        </div>
      </div>
    );
  }

  if (visual === 'grouped_table' && d0 && d1) {
    const groups = [...new Set(data.rows.map((r) => r[d0.id] ?? ''))];
    const columns =
      d1.codeList && data.labels[d1.codeList]
        ? Object.keys(data.labels[d1.codeList] ?? {}).filter((k) =>
            data.rows.some((r) => r[d1.id] === k),
          )
        : [...new Set(data.rows.map((r) => r[d1.id] ?? ''))];
    return (
      <div className="overflow-x-auto" data-visual="grouped_table">
        <table className="w-full text-sm">
          <thead className="text-left text-text-muted">
            <tr>
              <th className="whitespace-nowrap p-2 font-medium">{f.columnLabel(d0)}</th>
              {columns.map((c) => (
                <th key={c} className="whitespace-nowrap p-2 text-right font-medium">
                  {f.value(d1, c)}
                </th>
              ))}
              <th className="whitespace-nowrap p-2 text-right font-medium">{t('total')}</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => {
              const cells = columns.map((c) =>
                data.rows.find((r) => (r[d0.id] ?? '') === g && (r[d1.id] ?? '') === c),
              );
              return (
                <tr key={g} className="border-t border-border">
                  <td className="whitespace-nowrap p-2">{f.value(d0, g)}</td>
                  {cells.map((cell, i) => (
                    <td key={columns[i]} className="whitespace-nowrap p-2 text-right">
                      {cell ? (
                        <button
                          type="button"
                          className="underline decoration-dotted"
                          onClick={() => onDrill?.(cell)}
                        >
                          {f.value(m0, cell[m0.id])}
                        </button>
                      ) : (
                        '—'
                      )}
                    </td>
                  ))}
                  <td className="whitespace-nowrap p-2 text-right font-medium">
                    {f.value(m0, sumDecimals(cells.map((c) => c?.[m0.id] ?? '0')))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  // table (and any visual whose dimensions do not fit it)
  return (
    <div className="overflow-x-auto" data-visual="table">
      <table className="w-full text-sm">
        <thead className="text-left text-text-muted">
          <tr>
            {data.columns.map((c) => (
              <th
                key={c.id}
                className={`whitespace-nowrap p-2 font-medium ${c.role === 'measure' ? 'text-right' : ''}`}
              >
                {f.columnLabel(c)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((r, i) => (
            <tr
              key={i}
              className={`border-t border-border ${onDrill && dims.length ? 'cursor-pointer hover:bg-brand-purple-soft' : ''}`}
              onClick={() => (dims.length ? onDrill?.(r) : undefined)}
              data-drill-row={i}
            >
              {data.columns.map((c) => (
                <td
                  key={c.id}
                  className={`whitespace-nowrap p-2 ${c.role === 'measure' ? 'text-right' : ''}`}
                >
                  {f.value(c, r[c.id])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Legend({
  data,
  dim,
  measure,
  onDrill,
}: {
  data: Data;
  dim: Column;
  measure: Column;
  onDrill?: ((row: Record<string, string | null>) => void) | undefined;
}) {
  const f = useFormatters(data);
  return (
    <ul className="flex flex-1 flex-col gap-1 text-sm">
      {data.rows.map((r, i) => (
        <li key={i}>
          <button
            type="button"
            className="flex min-h-11 w-full items-center gap-2 text-left"
            onClick={() => onDrill?.(r)}
          >
            <span className="block size-3 shrink-0 rounded-sm" style={{ background: color(i) }} />
            <span className="flex-1 truncate text-text">{f.value(dim, r[dim.id])}</span>
            <span className="text-text-muted">{f.value(measure, r[measure.id])}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function SeriesLegend({ data, series }: { data: Data; series: Column[] }) {
  const f = useFormatters(data);
  return (
    <div className="flex flex-wrap gap-3 text-xs text-text-muted">
      {series.map((m, i) => (
        <span key={m.id} className="flex items-center gap-1">
          <span className="block size-3 rounded-sm" style={{ background: color(i) }} />
          {f.columnLabel(m)}
        </span>
      ))}
    </div>
  );
}
