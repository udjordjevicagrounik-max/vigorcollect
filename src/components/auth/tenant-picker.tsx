'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { postJSON } from '@/lib/post-json';
import { FormError, type FormProblem } from './form-message';

export type TenantChoice = { tenantId: string; tenantName: string };

// Binds the session to one membership; the server re-checks it (databaseHooks, ADR 0004).
export function TenantPicker({ choices }: { choices: TenantChoice[] }) {
  const t = useTranslations('auth');
  const [problem, setProblem] = useState<FormProblem | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  async function choose(tenantId: string) {
    setPending(tenantId);
    setProblem(null);
    const res = await postJSON('/api/auth/update-session', { activeTenantId: tenantId });
    if (res.status === 200) {
      window.location.assign('/');
      return;
    }
    setPending(null);
    if (res.status === 403) setProblem({ message: t('tenants.forbidden') });
    else setProblem({ message: t('common.unexpected'), requestId: res.requestId });
  }

  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-2">
        {choices.map((c) => (
          <li
            key={c.tenantId}
            className="flex min-h-11 items-center justify-between gap-3 rounded-md border border-border p-3"
          >
            <span className="font-medium text-text">{c.tenantName}</span>
            <button
              type="button"
              disabled={pending !== null}
              onClick={() => void choose(c.tenantId)}
              className="min-h-11 rounded-md bg-brand-green px-4 font-medium text-surface hover:bg-brand-green-deep disabled:opacity-60"
            >
              {t('tenants.choose')}
            </button>
          </li>
        ))}
      </ul>
      <FormError problem={problem} />
    </div>
  );
}
