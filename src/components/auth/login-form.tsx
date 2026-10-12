'use client';

import { useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { HONEYPOT_FIELD } from '@/lib/auth-policy';
import { postJSON } from '@/lib/post-json';
import { Field, SubmitButton } from './field';
import { FormError, Honeypot, type FormProblem } from './form-message';

// Password step. Wrong password, unknown e-mail and a locked account get the SAME message
// (rule 27; ADR 0004) — the server answers identically, so the form cannot tell them apart.
export function LoginForm() {
  const t = useTranslations('auth');
  const [problem, setProblem] = useState<FormProblem | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setProblem(null);
    const res = await postJSON('/api/auth/sign-in/email', {
      email: String(form.get('email') ?? ''),
      password: String(form.get('password') ?? ''),
      [HONEYPOT_FIELD]: String(form.get(HONEYPOT_FIELD) ?? ''),
    });
    if (res.status === 200) {
      const twoFactor = (res.json as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect;
      window.location.assign(twoFactor ? '/login/mfa' : '/');
      return;
    }
    setPending(false);
    if (res.status === 401 || res.status === 400) setProblem({ message: t('login.invalid') });
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
      <FormError problem={problem} />
      <SubmitButton label={pending ? t('login.submitting') : t('login.submit')} pending={pending} />
    </form>
  );
}
