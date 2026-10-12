'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { FormError, FormSuccess } from '@/components/auth/form-message';
import { useAction } from '@/components/admin/use-action';

// Case controls (task 2.4): stage (from the tenant code list, never 'legal'), priority, close,
// and "Hand over to legal" → approval request (rules 11, 19) with a reason.

const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
const LEGAL = 'legal';
const field = 'min-h-11 rounded-md border border-border bg-surface px-3 text-text';
const button =
  'min-h-11 rounded-md border border-brand-purple px-3 text-sm font-medium text-brand-purple hover:bg-brand-purple-soft disabled:opacity-60';

export function CaseActions({
  caseId,
  stage,
  priority,
  stages,
  canUpdate,
  canHandover,
  legalPending,
}: {
  caseId: string;
  stage: string;
  priority: string;
  stages: Record<string, string>;
  canUpdate: boolean;
  canHandover: boolean;
  legalPending: boolean;
}) {
  const t = useTranslations('collections.caseScreen');
  const { run, problem, notice, busy } = useAction();
  const [handover, setHandover] = useState(false);
  const [reason, setReason] = useState('');
  const [closing, setClosing] = useState(false);

  return (
    <section
      aria-label={t('controls')}
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
    >
      <FormError problem={problem} />
      <FormSuccess message={notice} />
      {canUpdate ? (
        <div className="grid gap-3 md:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm font-medium text-text">
            {t('stage')}
            <select
              className={field}
              value={stage}
              data-case-stage
              onChange={(e) =>
                void run('PUT', `/api/cases/${caseId}`, { stageCode: e.target.value }, t('saved'))
              }
              disabled={busy || stage === LEGAL}
            >
              {Object.entries(stages)
                .filter(([code]) => code !== LEGAL || stage === LEGAL)
                .map(([code, text]) => (
                  <option key={code} value={code}>
                    {text}
                  </option>
                ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm font-medium text-text">
            {t('priority')}
            <select
              className={field}
              value={priority}
              onChange={(e) =>
                void run('PUT', `/api/cases/${caseId}`, { priority: e.target.value }, t('saved'))
              }
              disabled={busy}
            >
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {t(`priorities.${p}`)}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {canHandover && stage !== LEGAL ? (
          legalPending ? (
            <p className="text-sm text-text-muted" data-legal-pending>
              {t('legalPending')}
            </p>
          ) : handover ? (
            <form
              className="flex w-full flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void run(
                  'POST',
                  `/api/cases/${caseId}/legal-handover`,
                  { reason },
                  t('legalRequested'),
                ).then((ok) => ok && setHandover(false));
              }}
            >
              <label className="flex flex-col gap-1 text-sm font-medium text-text">
                {t('legalReason')}
                <textarea
                  required
                  maxLength={500}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  className="min-h-20 rounded-md border border-border bg-surface p-2"
                />
              </label>
              <p className="text-xs text-text-muted">{t('legalHint')}</p>
              <div className="flex gap-2">
                <button type="submit" className={button} disabled={busy || !reason.trim()}>
                  {t('legalSend')}
                </button>
                <button type="button" className={button} onClick={() => setHandover(false)}>
                  {t('cancel')}
                </button>
              </div>
            </form>
          ) : (
            <button
              type="button"
              className={button}
              onClick={() => setHandover(true)}
              data-legal-handover
            >
              {t('legal')}
            </button>
          )
        ) : null}
        {canUpdate ? (
          closing ? (
            <>
              <span className="self-center text-sm text-text">{t('closeConfirm')}</span>
              <button
                type="button"
                className={button}
                disabled={busy}
                onClick={() =>
                  void run('PUT', `/api/cases/${caseId}`, { close: true }, t('closed'))
                }
              >
                {t('closeYes')}
              </button>
              <button type="button" className={button} onClick={() => setClosing(false)}>
                {t('cancel')}
              </button>
            </>
          ) : (
            <button type="button" className={button} onClick={() => setClosing(true)}>
              {t('close')}
            </button>
          )
        ) : null}
      </div>
    </section>
  );
}
