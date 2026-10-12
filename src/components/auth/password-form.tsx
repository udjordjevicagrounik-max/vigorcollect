'use client';

import { useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { MIN_PASSWORD_LENGTH } from '@/lib/auth-policy';
import { postJSON } from '@/lib/post-json';
import { Field, SubmitButton } from './field';
import { FormError, FormSuccess, type FormProblem } from './form-message';

// Password change. The server always ends every other session (ADR 0004, 1.1b).
export function PasswordForm() {
  const t = useTranslations('auth');
  const [problem, setProblem] = useState<FormProblem | null>(null);
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const next = String(form.get('next') ?? '');
    setDone(false);
    if (next.length < MIN_PASSWORD_LENGTH) {
      setProblem({ message: t('common.passwordTooShort', { min: MIN_PASSWORD_LENGTH }) });
      return;
    }
    if (next !== String(form.get('confirm') ?? '')) {
      setProblem({ message: t('common.passwordMismatch') });
      return;
    }
    setPending(true);
    setProblem(null);
    const res = await postJSON('/api/auth/change-password', {
      currentPassword: String(form.get('current') ?? ''),
      newPassword: next,
      revokeOtherSessions: true,
    });
    setPending(false);
    if (res.status === 200) {
      formElement.reset();
      setDone(true);
    } else if (res.status === 400 || res.status === 401)
      setProblem({ message: t('password.invalid') });
    else if (res.status === 429) setProblem({ message: t('common.rateLimited') });
    else setProblem({ message: t('common.unexpected'), requestId: res.requestId });
  }

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      <Field
        id="current"
        name="current"
        type="password"
        label={t('password.current')}
        autoComplete="current-password"
        required
      />
      <Field
        id="next"
        name="next"
        type="password"
        label={t('password.next')}
        hint={t('common.passwordHint', { min: MIN_PASSWORD_LENGTH })}
        autoComplete="new-password"
        minLength={MIN_PASSWORD_LENGTH}
        required
      />
      <Field
        id="confirm"
        name="confirm"
        type="password"
        label={t('password.confirm')}
        autoComplete="new-password"
        required
      />
      <FormError problem={problem} />
      <FormSuccess message={done ? t('password.done') : null} />
      <SubmitButton label={t('password.submit')} pending={pending} />
    </form>
  );
}
