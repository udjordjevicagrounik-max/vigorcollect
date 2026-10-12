'use client';

import { useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { MIN_PASSWORD_LENGTH } from '@/lib/auth-policy';
import { postJSON } from '@/lib/post-json';
import { Field, SubmitButton } from './field';
import { FormError, type FormProblem } from './form-message';
import { QrCode } from './qr-code';

type Enrollment = { totpURI: string; backupCodes: string[] };

// TOTP enrollment (MFA is mandatory, ADR 0004): password → QR + manual key + backup codes →
// first code. The secret lives only in this component's memory and in the authenticator app.
export function MfaSetup() {
  const t = useTranslations('auth');
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [problem, setProblem] = useState<FormProblem | null>(null);
  const [pending, setPending] = useState(false);

  async function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const password = String(new FormData(event.currentTarget).get('password') ?? '');
    setPending(true);
    setProblem(null);
    const res = await postJSON('/api/auth/two-factor/enable', { password });
    setPending(false);
    if (res.status === 200) setEnrollment(res.json as Enrollment);
    else if (res.status === 400 || res.status === 401)
      setProblem({ message: t('mfaSetup.passwordInvalid') });
    else if (res.status === 429) setProblem({ message: t('common.rateLimited') });
    else setProblem({ message: t('common.unexpected'), requestId: res.requestId });
  }

  async function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = String(new FormData(event.currentTarget).get('code') ?? '').replace(/\s/g, '');
    setPending(true);
    setProblem(null);
    const res = await postJSON('/api/auth/two-factor/verify-totp', { code });
    if (res.status === 200) {
      window.location.assign('/');
      return;
    }
    setPending(false);
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      setProblem({ message: t('mfaSetup.codeInvalid') });
    } else if (res.status === 429) setProblem({ message: t('common.rateLimited') });
    else setProblem({ message: t('common.unexpected'), requestId: res.requestId });
  }

  if (!enrollment) {
    return (
      <form onSubmit={start} noValidate className="flex flex-col gap-4">
        <Field
          id="password"
          name="password"
          type="password"
          label={t('mfaSetup.passwordLabel')}
          autoComplete="current-password"
          minLength={MIN_PASSWORD_LENGTH}
          required
        />
        <FormError problem={problem} />
        <SubmitButton label={t('mfaSetup.start')} pending={pending} />
      </form>
    );
  }

  const secret = new URL(enrollment.totpURI).searchParams.get('secret') ?? '';
  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col items-center gap-3">
        <h2 className="self-start font-semibold text-text">{t('mfaSetup.scanTitle')}</h2>
        <QrCode value={enrollment.totpURI} label={t('mfaSetup.qrLabel')} />
        <details className="w-full rounded-md border border-border p-3">
          <summary className="min-h-11 cursor-pointer content-center text-brand-purple">
            {t('mfaSetup.manualTitle')}
          </summary>
          <p className="mt-2 text-sm text-text-muted">{t('mfaSetup.manualHint')}</p>
          <code
            data-testid="totp-secret"
            className="mt-2 block break-all font-mono text-sm text-text"
          >
            {secret}
          </code>
          <a
            href={enrollment.totpURI}
            className="mt-2 inline-block min-h-11 content-center text-brand-purple underline"
          >
            {t('mfaSetup.openApp')}
          </a>
        </details>
      </section>
      <section className="flex flex-col gap-2">
        <h2 className="font-semibold text-text">{t('mfaSetup.backupTitle')}</h2>
        <p className="text-sm text-text-muted">{t('mfaSetup.backupHint')}</p>
        <ul className="grid grid-cols-2 gap-1 font-mono text-sm text-text">
          {enrollment.backupCodes.map((code) => (
            <li key={code}>{code}</li>
          ))}
        </ul>
      </section>
      <form onSubmit={verify} noValidate className="flex flex-col gap-4">
        <h2 className="font-semibold text-text">{t('mfaSetup.codeTitle')}</h2>
        <Field
          id="code"
          name="code"
          label={t('mfaSetup.code')}
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]*"
          maxLength={6}
          required
        />
        <FormError problem={problem} />
        <SubmitButton label={t('mfaSetup.verify')} pending={pending} />
      </form>
    </div>
  );
}
