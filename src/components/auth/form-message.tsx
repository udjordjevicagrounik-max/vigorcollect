'use client';

import { useTranslations } from 'next-intl';

export type FormProblem = { message: string; requestId?: string | null };

// Error with a human text and, when the server answered, the request id for support (rule 29).
export function FormError({ problem }: { problem: FormProblem | null }) {
  const t = useTranslations('auth.common');
  if (!problem) return null;
  return (
    <div
      role="alert"
      className="rounded-md border border-status-danger-fg bg-status-danger-bg p-3 text-sm text-status-danger-fg"
    >
      <p>{problem.message}</p>
      {problem.requestId ? (
        <p className="mt-1 font-mono text-xs">{t('requestId', { requestId: problem.requestId })}</p>
      ) : null}
    </div>
  );
}

export function FormSuccess({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p
      role="status"
      className="rounded-md border border-status-success-fg bg-status-success-bg p-3 text-sm text-status-success-fg"
    >
      {message}
    </p>
  );
}

/** Off-screen honeypot input (rule 27): people never see or fill it; bots do. */
export function Honeypot({ name }: { name: string }) {
  const t = useTranslations('auth.common');
  return (
    <div aria-hidden="true" className="absolute -left-[10000px] h-px w-px overflow-hidden">
      <label htmlFor="hp-field">{t('honeypot')}</label>
      <input id="hp-field" name={name} type="text" tabIndex={-1} autoComplete="off" />
    </div>
  );
}
