import type { ReactNode } from 'react';

// One KPI with its definition (docs/metrics.md) — a disclosure instead of a hover tooltip, so it
// works on touch screens and with a keyboard; `title` keeps the hover hint on desktop.
export function KpiCard({
  id,
  label,
  value,
  definition,
  definitionLabel,
  note,
  href,
}: {
  id: string;
  label: string;
  value: ReactNode;
  definition: string;
  definitionLabel: string;
  note?: string | null;
  href?: string;
}) {
  const body = (
    <>
      <p className="text-sm text-text-muted">{label}</p>
      <p className="mt-1 text-xl font-semibold text-brand-green" data-kpi-value>
        {value}
      </p>
      {note ? <p className="mt-1 text-xs text-status-warning-fg">{note}</p> : null}
    </>
  );
  return (
    <div
      className="rounded-lg border border-border bg-surface p-4"
      data-kpi={id}
      title={definition}
    >
      {href ? (
        <a href={href} className="block hover:underline">
          {body}
        </a>
      ) : (
        body
      )}
      <details className="mt-2 text-xs text-text-muted">
        <summary className="min-h-6 cursor-pointer text-brand-purple">{definitionLabel}</summary>
        <p className="mt-1">{definition}</p>
      </details>
    </div>
  );
}
