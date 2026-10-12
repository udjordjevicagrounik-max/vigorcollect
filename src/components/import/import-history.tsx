import { getFormatter, getTranslations } from 'next-intl/server';

const WHEN = { dateStyle: 'medium', timeStyle: 'short' } as const;

type StatusKey =
  keyof (typeof import('../../../messages/sr-Latn.json'))['importPage']['history']['status'];

type Run = {
  id: string;
  status: string;
  fileFormat: string;
  rowsTotal: number;
  rowsValid: number;
  invoicesCreated: number;
  invoicesUpdated: number;
  exceptionsCount: number;
  createdAt: string;
};

// History of import runs (import.read). Empty state explains the first import (rule 29).
export async function ImportHistory({ runs }: { runs: Run[] }) {
  const t = await getTranslations('importPage.history');
  const format = await getFormatter();
  return (
    <section aria-labelledby="import-history" className="mt-6">
      <h2 id="import-history" className="font-semibold text-text">
        {t('title')}
      </h2>
      {runs.length === 0 ? (
        <p className="mt-2 rounded-lg border border-border bg-surface p-4 text-text-muted">
          {t('empty')}
        </p>
      ) : (
        <ul className="mt-2 flex flex-col gap-2">
          {runs.map((r) => (
            <li
              key={r.id}
              className="rounded-lg border border-border bg-surface p-3 text-sm"
              data-import-run={r.status}
            >
              <span className="font-medium text-text">
                {format.dateTime(new Date(r.createdAt), WHEN)}
              </span>{' '}
              · {r.fileFormat.toUpperCase()} · {t(`status.${r.status as StatusKey}`)}
              <span className="block text-text-muted">
                {t('counts', {
                  rows: r.rowsTotal,
                  valid: r.rowsValid,
                  created: r.invoicesCreated,
                  updated: r.invoicesUpdated,
                  exceptions: r.exceptionsCount,
                })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
