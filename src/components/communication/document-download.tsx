'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { FormError, FormSuccess, type FormProblem } from '@/components/auth/form-message';
import { useAction } from '@/components/admin/use-action';
import { apiProblem } from '@/lib/api-problem';
import { postJSON } from '@/lib/post-json';

const PURPOSES = ['customer_correspondence', 'internal_review', 'legal'] as const;

// Download of a document's PDF (task 3.3) through exportService: a signed 5-minute link for
// this member, written to export_log with the chosen purpose (rule 12). No PDF yet: ask the
// worker to render it.
export function DocumentDownload({
  documentId,
  hasPdf,
  canRequest,
}: {
  documentId: string;
  hasPdf: boolean;
  canRequest: boolean;
}) {
  const t = useTranslations('documents');
  const tErrors = useTranslations('errors');
  const { run, problem, notice, busy } = useAction();
  const [purpose, setPurpose] = useState<(typeof PURPOSES)[number]>('customer_correspondence');
  const [linkProblem, setLinkProblem] = useState<FormProblem | null>(null);
  const [pending, setPending] = useState(false);

  async function download() {
    setPending(true);
    setLinkProblem(null);
    const res = await postJSON(`/api/documents/${documentId}/link`, { purpose });
    setPending(false);
    const url = (res.json as { url?: unknown } | null)?.url;
    if (res.status === 200 && typeof url === 'string' && url.startsWith('/api/documents/')) {
      window.location.assign(url);
      return;
    }
    setLinkProblem(apiProblem(res, tErrors));
  }

  if (!hasPdf)
    return (
      <div className="mt-3 flex flex-col gap-2" data-document-pdf="pending">
        <FormError problem={problem} />
        <FormSuccess message={notice} />
        <p className="text-sm text-text-muted">{t('pdfPending')}</p>
        {canRequest ? (
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run('POST', `/api/documents/${documentId}/render`, {}, t('pdfRequested'))
            }
            className="min-h-11 self-start rounded-md border border-brand-purple px-3 text-sm font-medium text-brand-purple hover:bg-brand-purple-soft disabled:opacity-60"
          >
            {t('pdfRequest')}
          </button>
        ) : null}
      </div>
    );
  return (
    <div className="mt-3 flex flex-col gap-2" data-document-pdf="ready">
      <FormError problem={linkProblem} />
      <label htmlFor="export-purpose" className="text-sm font-medium text-text">
        {t('purpose')}
      </label>
      <select
        id="export-purpose"
        value={purpose}
        onChange={(e) => setPurpose(e.target.value as (typeof PURPOSES)[number])}
        className="min-h-11 rounded-md border border-border bg-surface px-3 text-text sm:max-w-xs"
      >
        {PURPOSES.map((p) => (
          <option key={p} value={p}>
            {t(`purposes.${p}`)}
          </option>
        ))}
      </select>
      <button
        type="button"
        disabled={pending}
        onClick={() => void download()}
        data-document-download
        className="min-h-11 self-start rounded-md bg-brand-green px-3 text-sm font-medium text-surface disabled:opacity-60"
      >
        {t('downloadPdf')}
      </button>
      <p className="text-xs text-text-muted">{t('downloadLogged')}</p>
    </div>
  );
}
