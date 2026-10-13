'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { FormError, FormSuccess, type FormProblem } from '@/components/auth/form-message';
import { apiProblem } from '@/lib/api-problem';
import { REQUEST_ID_HEADER } from '@/lib/request-id';

// Export button (5.2) for lists and reports: POST /api/exports with the CURRENT filters in the
// body (never the URL). Small → the browser saves the file; large (202) → prepared by the
// worker, the member finds it under Reports → My exports.

const cls =
  'min-h-11 rounded-md border border-border bg-surface px-3 text-sm font-medium text-brand-purple disabled:opacity-60';

export function ExportButton({
  type,
  filters,
}: {
  type: string;
  filters: Record<string, unknown>;
}) {
  const t = useTranslations('exports');
  const tErrors = useTranslations('errors');
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<FormProblem | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function run(format: 'csv' | 'xlsx') {
    setBusy(true);
    setProblem(null);
    setNotice(null);
    try {
      const res = await fetch('/api/exports', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type, format, filters }),
      });
      if (res.status === 202) {
        setNotice(t('queued'));
        router.refresh();
      } else if (res.ok) {
        const blob = await res.blob();
        const name =
          /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ??
          `export.${format}`;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        a.click();
        URL.revokeObjectURL(url);
        setNotice(t('done', { n: Number(res.headers.get('x-export-rows') ?? '0') }));
      } else {
        const text = await res.text();
        let json: unknown = null;
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
        setProblem(
          apiProblem(
            { status: res.status, json, requestId: res.headers.get(REQUEST_ID_HEADER) },
            tErrors,
          ),
        );
      }
    } catch {
      setProblem(apiProblem({ status: 0, json: null, requestId: null }, tErrors));
    }
    setBusy(false);
  }

  return (
    <div className="flex flex-col gap-1" data-export={type}>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={cls}
          disabled={busy}
          onClick={() => void run('csv')}
          data-export-format="csv"
        >
          {t('button')} CSV
        </button>
        <button
          type="button"
          className={cls}
          disabled={busy}
          onClick={() => void run('xlsx')}
          data-export-format="xlsx"
        >
          {t('button')} XLSX
        </button>
      </div>
      <FormError problem={problem} />
      <FormSuccess message={notice} />
    </div>
  );
}
