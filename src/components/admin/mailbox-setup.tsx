'use client';

import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { FormError, FormSuccess, type FormProblem } from '@/components/auth/form-message';
import { useAction } from '@/components/admin/use-action';
import { apiProblem } from '@/lib/api-problem';
import { postJSON } from '@/lib/post-json';

// Admin → Integrations → Mail (5.3). IMAP/SMTP form (the password is never shown again —
// "set"), "Check connection" (the worker probes, then connects n8n; this view refreshes),
// "Connect Microsoft 365" only when the server has the app keys, Google "coming soon".

type View = {
  provider: 'imap_smtp' | 'microsoft365' | null;
  status: string | null;
  imapHost: string | null;
  imapPort: number | null;
  imapTls: boolean | null;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpSecurity: string | null;
  folder: string;
  passwordSet: boolean;
  usernameSet: boolean;
  fromAddressSet: boolean;
  lastTestAt: string | null;
  lastError: string | null;
  connected: boolean;
  microsoftAvailable: boolean;
};

const field = 'min-h-11 rounded-md border border-border bg-surface px-3 text-text';
const label = 'flex flex-col gap-1 text-sm font-medium text-text';
const submit =
  'min-h-11 rounded-md bg-brand-green px-4 font-medium text-surface hover:bg-brand-green-deep disabled:opacity-60';
const secondary =
  'min-h-11 rounded-md border border-border bg-surface px-3 text-sm font-medium text-brand-purple disabled:opacity-60';
const IMAP_PORTS = [993, 143] as const;
const SMTP_PORTS = [587, 465, 25, 2525] as const;
const SECURITY = ['starttls', 'tls', 'none'] as const;
const IMAP_EXAMPLE = 'imap.example.com';
const SMTP_EXAMPLE = 'smtp.example.com';

export function MailboxSetup({
  view,
  canManage,
  microsoftOutcome,
}: {
  view: View;
  canManage: boolean;
  microsoftOutcome: 'connected' | 'denied' | 'failed' | null;
}) {
  const t = useTranslations('mailbox');
  const tErrors = useTranslations('errors');
  const save = useAction();
  const check = useAction();
  const [msProblem, setMsProblem] = useState<FormProblem | null>(null);

  async function onSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    const password = String(f.get('password') ?? '');
    const from = String(f.get('fromAddress') ?? '').trim();
    await save.run(
      'PUT',
      '/api/integrations/mailbox',
      {
        imapHost: String(f.get('imapHost') ?? ''),
        imapPort: Number(f.get('imapPort')),
        imapTls: Number(f.get('imapPort')) === 993,
        smtpHost: String(f.get('smtpHost') ?? ''),
        smtpPort: Number(f.get('smtpPort')),
        smtpSecurity: String(f.get('smtpSecurity')),
        username: String(f.get('username') ?? ''),
        ...(password ? { password } : {}),
        folder: String(f.get('folder') ?? 'INBOX') || 'INBOX',
        ...(from ? { fromAddress: from } : {}),
      },
      t('saved'),
    );
  }

  async function connectMicrosoft() {
    setMsProblem(null);
    const res = await postJSON('/api/integrations/microsoft/start', {});
    const url = (res.json as { url?: string } | null)?.url;
    if (res.status === 200 && url) window.location.assign(url);
    else setMsProblem(apiProblem(res, tErrors));
  }

  const status = view.status ?? 'none';
  return (
    <section className="mt-6 rounded-lg border border-border bg-surface p-4" data-mailbox={status}>
      <h2 className="font-semibold text-brand-green">{t('title')}</h2>
      <p className="mt-1 max-w-prose text-sm text-text-muted">{t('description')}</p>
      <p className="mt-2 text-sm font-medium text-text" data-mailbox-status={status}>
        {t(`status.${status as 'none'}`)}
        {view.lastError
          ? ` · ${t.has(`errors.${view.lastError}` as 'errors.n8n_failed') ? t(`errors.${view.lastError}` as 'errors.n8n_failed') : view.lastError}`
          : ''}
      </p>
      {microsoftOutcome ? (
        <p className="mt-1 text-sm text-text-muted" data-microsoft-outcome={microsoftOutcome}>
          {t(`microsoft.${microsoftOutcome}`)}
        </p>
      ) : null}

      {canManage ? (
        <form
          onSubmit={(e) => void onSave(e)}
          className="mt-4 grid gap-3 md:grid-cols-2"
          data-mailbox-form
        >
          <label className={label}>
            {t('imapHost')}
            <input
              name="imapHost"
              required
              defaultValue={view.imapHost ?? ''}
              placeholder={IMAP_EXAMPLE}
              className={field}
            />
          </label>
          <label className={label}>
            {t('imapPort')}
            <select name="imapPort" defaultValue={String(view.imapPort ?? 993)} className={field}>
              {IMAP_PORTS.map((p) => (
                <option key={p} value={p}>
                  {t(`imapPorts.${p}`)}
                </option>
              ))}
            </select>
          </label>
          <label className={label}>
            {t('smtpHost')}
            <input
              name="smtpHost"
              required
              defaultValue={view.smtpHost ?? ''}
              placeholder={SMTP_EXAMPLE}
              className={field}
            />
          </label>
          <div className="flex gap-2">
            <label className={label}>
              {t('smtpPort')}
              <select name="smtpPort" defaultValue={String(view.smtpPort ?? 587)} className={field}>
                {SMTP_PORTS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </label>
            <label className={label}>
              {t('smtpSecurity')}
              <select
                name="smtpSecurity"
                defaultValue={view.smtpSecurity ?? 'starttls'}
                className={field}
              >
                {SECURITY.map((s) => (
                  <option key={s} value={s}>
                    {t(`security.${s}`)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className={label}>
            {t('username')}
            <input
              name="username"
              required
              autoComplete="off"
              placeholder={view.usernameSet ? t('setKeep') : ''}
              className={field}
            />
          </label>
          <label className={label}>
            {t('password')}
            <input
              name="password"
              type="password"
              autoComplete="new-password"
              required={!view.passwordSet}
              placeholder={view.passwordSet ? t('setKeep') : ''}
              className={field}
            />
          </label>
          <label className={label}>
            {t('folder')}
            <input name="folder" defaultValue={view.folder} className={field} />
          </label>
          <label className={label}>
            {t('fromAddress')}
            <input
              name="fromAddress"
              type="email"
              autoComplete="off"
              placeholder={view.fromAddressSet ? t('setKeep') : ''}
              className={field}
            />
          </label>
          <p className="text-xs text-text-muted md:col-span-2">{t('gmailHint')}</p>
          <div className="flex flex-wrap gap-2 md:col-span-2">
            <button type="submit" className={submit} disabled={save.busy}>
              {t('save')}
            </button>
            <button
              type="button"
              className={secondary}
              disabled={check.busy || !view.provider}
              data-mailbox-check
              onClick={() =>
                void check.run('POST', '/api/integrations/mailbox/test', {}, t('checking'))
              }
            >
              {t('check')}
            </button>
          </div>
          <div className="md:col-span-2">
            <FormError problem={save.problem ?? check.problem} />
            <FormSuccess message={save.notice ?? check.notice} />
          </div>
        </form>
      ) : null}

      {canManage ? (
        <div className="mt-4 flex flex-col gap-2 border-t border-border pt-4">
          {view.microsoftAvailable ? (
            <button
              type="button"
              className={`${secondary} self-start`}
              onClick={() => void connectMicrosoft()}
              data-microsoft-connect
            >
              {t('microsoft.connect')}
            </button>
          ) : null}
          <p className="text-sm text-text-muted" data-google-soon>
            {t('google')}
          </p>
          <FormError problem={msProblem} />
        </div>
      ) : null}
    </section>
  );
}
