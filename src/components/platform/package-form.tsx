'use client';

import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { TurnstileWidget } from '@/components/auth/turnstile-widget';
import { postJSON } from '@/lib/post-json';

// The client's data package (6.4): what we need with examples, file upload (CSV / XLSX — sealed,
// waits for the implementation team), and 10 questions about the collection policy.

const QUESTIONS: Record<string, readonly string[]> = {
  payment_terms: ['15', '30', '60', '90'],
  reminder_before_due: ['yes', 'no'],
  first_reminder: ['d1', 'd7', 'd15'],
  tone: ['friendly', 'neutral', 'firm'],
  phone_followup: ['yes', 'no'],
  escalation: ['d15', 'd30', 'd60', 'd90'],
  legal_handover: ['d30', 'd60', 'd90', 'never'],
  seasonal: ['yes', 'no'],
  natural_persons: ['yes', 'no'],
  disputes_common: ['yes', 'no'],
};
const NEEDED = ['invoices', 'customers', 'contacts', 'payments', 'templates', 'policy'] as const;
const field = 'min-h-11 rounded-md border border-border bg-surface px-3 text-text';

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function PackageForm({
  token,
  siteKey,
  nonce,
  files: initialFiles,
  answered,
}: {
  token: string;
  siteKey: string | null;
  nonce?: string | undefined;
  files: number;
  answered: boolean;
}) {
  const t = useTranslations('package');
  const [captcha, setCaptcha] = useState<string | null>(null);
  const [reset, setReset] = useState(0);
  const [files, setFiles] = useState(initialFiles);
  const [message, setMessage] = useState<string | null>(null);
  const [proposal, setProposal] = useState<string | null>(answered ? 'saved' : null);
  const [busy, setBusy] = useState(false);
  const url = `/api/public/package/${token}`;

  async function upload(list: FileList | null) {
    if (!list?.length) return;
    setBusy(true);
    setMessage(null);
    for (const file of Array.from(list)) {
      const format = file.name.toLowerCase().endsWith('.xlsx') ? 'xlsx' : 'csv';
      const res = await postJSON(url, {
        kind: 'file',
        fileName: file.name,
        format,
        content: toBase64(await file.arrayBuffer()),
        captchaToken: captcha ?? undefined,
      });
      const outcome = (res.json as { outcome?: string } | null)?.outcome ?? 'invalid';
      setReset((r) => r + 1);
      if (outcome === 'ok') setFiles((n) => n + 1);
      else {
        setMessage(t(`outcomes.${outcome as 'invalid'}`));
        break;
      }
    }
    setBusy(false);
  }

  async function answer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    setBusy(true);
    const res = await postJSON(url, {
      kind: 'answers',
      answers: Object.fromEntries(Object.keys(QUESTIONS).map((k) => [k, String(f.get(k))])),
      captchaToken: captcha ?? undefined,
    });
    setBusy(false);
    setReset((r) => r + 1);
    const body = res.json as { outcome?: string; proposal?: string } | null;
    if (body?.outcome === 'ok') setProposal(body.proposal ?? 'saved');
    else setMessage(t('outcomes.invalid'));
  }

  return (
    <div className="flex flex-col gap-6" data-package>
      <section>
        <h2 className="font-semibold text-brand-green">{t('neededTitle')}</h2>
        <ul className="mt-2 flex flex-col gap-2 text-sm">
          {NEEDED.map((n) => (
            <li key={n} className="rounded-md border border-border p-2">
              <span className="font-medium text-text">{t(`needed.${n}.title`)}</span>
              <span className="block text-text-muted">{t(`needed.${n}.example`)}</span>
            </li>
          ))}
        </ul>
      </section>

      <TurnstileWidget siteKey={siteKey} nonce={nonce} onToken={setCaptcha} resetSignal={reset} />

      <section>
        <h2 className="font-semibold text-brand-green">{t('filesTitle')}</h2>
        <p className="text-sm text-text-muted">{t('filesHint', { n: files })}</p>
        <input
          type="file"
          multiple
          accept=".csv,.xlsx"
          disabled={busy || (Boolean(siteKey) && !captcha)}
          onChange={(e) => void upload(e.target.files)}
          className="mt-2 block min-h-11 text-sm"
          data-package-files
        />
      </section>

      <section>
        <h2 className="font-semibold text-brand-green">{t('questionsTitle')}</h2>
        {proposal ? (
          <p
            className="mt-2 rounded-md bg-status-success-bg p-3 text-sm text-status-success-fg"
            role="status"
            data-package-answered
          >
            {proposal === 'saved'
              ? t('answered')
              : t('proposal', { policy: t(`policies.${proposal as 'standard'}`) })}
          </p>
        ) : (
          <form onSubmit={(e) => void answer(e)} className="mt-2 flex flex-col gap-3">
            {Object.entries(QUESTIONS).map(([q, opts]) => (
              <label key={q} className="flex flex-col gap-1 text-sm font-medium text-text">
                {t(`questions.${q as 'tone'}.q`)}
                <select name={q} required className={field}>
                  {opts.map((o) => (
                    <option key={o} value={o}>
                      {t(`questions.${q as 'tone'}.a.${o as 'friendly'}`)}
                    </option>
                  ))}
                </select>
              </label>
            ))}
            <button
              type="submit"
              disabled={busy || (Boolean(siteKey) && !captcha)}
              className="min-h-11 rounded-md bg-brand-green px-4 font-medium text-surface disabled:opacity-60"
            >
              {t('send')}
            </button>
          </form>
        )}
      </section>
      {message ? (
        <p className="text-sm text-status-danger-fg" role="alert">
          {message}
        </p>
      ) : null}
    </div>
  );
}
