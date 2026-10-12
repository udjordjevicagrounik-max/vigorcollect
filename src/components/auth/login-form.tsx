'use client';

import { useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { ContinueFallback, useNavigateWithFallback } from './continue-fallback';
import { HONEYPOT_FIELD } from '@/lib/auth-policy';
import { isCaptchaError, postJSON } from '@/lib/post-json';
import { Field, SubmitButton } from './field';
import { FormError, Honeypot, type FormProblem } from './form-message';
import { TurnstileWidget } from './turnstile-widget';

// Password step. Wrong password, unknown e-mail and a locked account get the SAME message
// (rule 27; ADR 0004) — the server answers identically, so the form cannot tell them apart.
export function LoginForm({
  siteKey,
  nonce,
}: {
  siteKey: string | null;
  nonce?: string | undefined;
}) {
  const t = useTranslations('auth');
  const tErrors = useTranslations('errors');
  const [captcha, setCaptcha] = useState<string | null>(null);
  const [resetSignal, setResetSignal] = useState(0);
  const [problem, setProblem] = useState<FormProblem | null>(null);
  const [pending, setPending] = useState(false);
  const { go, fallbackHref } = useNavigateWithFallback();

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (siteKey && !captcha) {
      setProblem({ message: tErrors('captcha_failed') });
      return;
    }
    setPending(true);
    setProblem(null);
    const res = await postJSON(
      '/api/auth/sign-in/email',
      {
        email: String(form.get('email') ?? ''),
        password: String(form.get('password') ?? ''),
        [HONEYPOT_FIELD]: String(form.get(HONEYPOT_FIELD) ?? ''),
      },
      captcha ? { 'x-captcha-response': captcha } : {},
    );
    if (res.status === 200) {
      const twoFactor = (res.json as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect;
      go(twoFactor ? '/login/mfa' : '/');
      return;
    }
    setPending(false);
    // A Turnstile token is single-use: always ask for a fresh one after an attempt.
    setCaptcha(null);
    setResetSignal((n) => n + 1);
    if (isCaptchaError(res.json)) setProblem({ message: tErrors('captcha_failed') });
    else if (res.status === 401 || res.status === 400) setProblem({ message: t('login.invalid') });
    else if (res.status === 429) setProblem({ message: t('common.rateLimited') });
    else setProblem({ message: t('common.unexpected'), requestId: res.requestId });
  }

  return (
    <form onSubmit={onSubmit} noValidate className="relative flex flex-col gap-4">
      <Field
        id="email"
        name="email"
        type="email"
        label={t('login.email')}
        autoComplete="username"
        required
      />
      <Field
        id="password"
        name="password"
        type="password"
        label={t('login.password')}
        autoComplete="current-password"
        required
      />
      <Honeypot name={HONEYPOT_FIELD} />
      <TurnstileWidget
        siteKey={siteKey}
        nonce={nonce}
        onToken={setCaptcha}
        resetSignal={resetSignal}
      />
      <FormError problem={problem} />
      <ContinueFallback href={fallbackHref} />
      <SubmitButton label={pending ? t('login.submitting') : t('login.submit')} pending={pending} />
    </form>
  );
}
