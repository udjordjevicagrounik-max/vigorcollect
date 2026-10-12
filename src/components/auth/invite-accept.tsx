'use client';

import { useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { HONEYPOT_FIELD, MIN_PASSWORD_LENGTH } from '@/lib/auth-policy';
import { errorCode, postJSON } from '@/lib/post-json';
import { Field, SubmitButton } from './field';
import { FormError, FormSuccess, Honeypot, type FormProblem } from './form-message';

type Mode = 'new' | 'existing';

// Accepting an invitation: a new person sets a password; a person who already has an account
// accepts while signed in (the server takes the identity from the session cookie only).
export function InviteAccept({
  token,
  existingAccount,
}: {
  token: string;
  existingAccount: boolean;
}) {
  const mode: Mode = existingAccount ? 'existing' : 'new';
  const t = useTranslations('auth');
  const [problem, setProblem] = useState<FormProblem | null>(null);
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body: Record<string, string> = {
      token,
      [HONEYPOT_FIELD]: String(form.get(HONEYPOT_FIELD) ?? ''),
    };
    if (mode === 'new') {
      const password = String(form.get('password') ?? '');
      if (password.length < MIN_PASSWORD_LENGTH) {
        setProblem({ message: t('common.passwordTooShort', { min: MIN_PASSWORD_LENGTH }) });
        return;
      }
      if (password !== String(form.get('confirm') ?? '')) {
        setProblem({ message: t('common.passwordMismatch') });
        return;
      }
      body.password = password;
    }
    setPending(true);
    setProblem(null);
    const res = await postJSON('/api/invitations/accept', body);
    setPending(false);
    if (res.status === 200) {
      setDone(true);
      return;
    }
    const code = errorCode(res.json);
    if (code === 'weak_password') {
      setProblem({ message: t('common.passwordTooShort', { min: MIN_PASSWORD_LENGTH }) });
    } else if (code === 'expired') setProblem({ message: t('invite.expiredTitle') });
    else if (code === 'wrong_account') setProblem({ message: t('invite.wrongAccount') });
    else if (code === 'sign_in_required') setProblem({ message: t('invite.existingDescription') });
    else if (res.status === 400) setProblem({ message: t('invite.invalidDescription') });
    else if (res.status === 429) setProblem({ message: t('common.rateLimited') });
    else setProblem({ message: t('common.unexpected'), requestId: res.requestId });
  }

  if (done) {
    return (
      <div className="flex flex-col gap-4">
        <FormSuccess message={t('invite.doneTitle')} />
        <p className="text-text-muted">{t('invite.doneDescription')}</p>
        <Link
          href="/login"
          className="inline-flex min-h-11 items-center justify-center rounded-md bg-brand-green px-4 font-medium text-surface hover:bg-brand-green-deep"
        >
          {t('invite.doneAction')}
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate className="relative flex flex-col gap-4">
      {mode === 'new' ? (
        <>
          <Field
            id="password"
            name="password"
            type="password"
            label={t('invite.password')}
            hint={t('common.passwordHint', { min: MIN_PASSWORD_LENGTH })}
            autoComplete="new-password"
            minLength={MIN_PASSWORD_LENGTH}
            required
          />
          <Field
            id="confirm"
            name="confirm"
            type="password"
            label={t('invite.confirm')}
            autoComplete="new-password"
            required
          />
        </>
      ) : null}
      <Honeypot name={HONEYPOT_FIELD} />
      <FormError problem={problem} />
      <SubmitButton
        label={mode === 'new' ? t('invite.submit') : t('invite.existingAccept')}
        pending={pending}
      />
    </form>
  );
}
