'use client';

import { useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { ContinueFallback, useNavigateWithFallback } from './continue-fallback';
import Link from 'next/link';
import { errorCode, postJSON } from '@/lib/post-json';
import { Field, SubmitButton } from './field';
import { FormError, type FormProblem } from './form-message';

// Second factor at sign-in (TOTP). The two-factor plugin locks after 5 wrong codes (15 min).
export function MfaForm() {
  const t = useTranslations('auth');
  const [problem, setProblem] = useState<FormProblem | null>(null);
  const [expired, setExpired] = useState(false);
  const [pending, setPending] = useState(false);
  const { go, fallbackHref } = useNavigateWithFallback();

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = String(new FormData(event.currentTarget).get('code') ?? '').replace(/\s/g, '');
    setPending(true);
    setProblem(null);
    const res = await postJSON('/api/auth/two-factor/verify-totp', { code });
    if (res.status === 200) {
      go('/');
      return;
    }
    setPending(false);
    if (/COOKIE|SESSION/.test(errorCode(res.json))) {
      setExpired(true);
      setProblem({ message: t('mfa.expired') });
    } else if (res.status === 401 || res.status === 400 || res.status === 403) {
      setProblem({ message: t('mfa.invalid') });
    } else if (res.status === 429) setProblem({ message: t('common.rateLimited') });
    else setProblem({ message: t('common.unexpected'), requestId: res.requestId });
  }

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      <Field
        id="code"
        name="code"
        label={t('mfa.code')}
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]*"
        maxLength={6}
        required
      />
      <FormError problem={problem} />
      <ContinueFallback href={fallbackHref} />
      {expired ? (
        <Link href="/login" className="min-h-11 text-brand-purple underline">
          {t('common.backToLogin')}
        </Link>
      ) : (
        <SubmitButton label={t('mfa.submit')} pending={pending} />
      )}
    </form>
  );
}
