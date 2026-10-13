'use client';

import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { TurnstileWidget } from '@/components/auth/turnstile-widget';
import { postJSON } from '@/lib/post-json';

// Public signup (6.4): a sandbox with demo data for 7 days. The answer is always the same
// ("check your e-mail") — nothing tells whether the address is known (rule 27).

const field = 'min-h-11 rounded-md border border-border bg-surface px-3 text-text';
const label = 'flex flex-col gap-1 text-sm font-medium text-text';

export function SignupForm({
  siteKey,
  nonce,
  countries,
}: {
  siteKey: string | null;
  nonce?: string | undefined;
  countries: string[];
}) {
  const t = useTranslations('signup');
  const [captcha, setCaptcha] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    setBusy(true);
    await postJSON('/api/public/signup', {
      company: String(f.get('company') ?? ''),
      name: String(f.get('name') ?? ''),
      email: String(f.get('email') ?? ''),
      country: String(f.get('country') ?? 'RS'),
      locale: String(f.get('locale') ?? 'sr-Latn'),
      website: String(f.get('website') ?? ''),
      captchaToken: captcha ?? undefined,
    });
    setBusy(false);
    setDone(true);
  }

  if (done)
    return (
      <p
        className="rounded-md bg-status-success-bg p-3 text-sm text-status-success-fg"
        role="status"
        data-signup-done
      >
        {t('done')}
      </p>
    );
  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3" data-signup-form>
      <label className={label}>
        {t('company')}
        <input
          name="company"
          required
          minLength={2}
          maxLength={200}
          className={field}
          autoComplete="organization"
        />
      </label>
      <label className={label}>
        {t('name')}
        <input
          name="name"
          required
          minLength={2}
          maxLength={200}
          className={field}
          autoComplete="name"
        />
      </label>
      <label className={label}>
        {t('email')}
        <input
          name="email"
          type="email"
          required
          maxLength={254}
          className={field}
          autoComplete="email"
        />
      </label>
      <div className="flex gap-2">
        <label className={`${label} flex-1`}>
          {t('country')}
          <select name="country" className={field} defaultValue={countries[0]}>
            {countries.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label className={`${label} flex-1`}>
          {t('language')}
          <select name="locale" className={field} defaultValue={SR}>
            <option value={SR}>{t('languages.sr')}</option>
            <option value={EN}>{t('languages.en')}</option>
          </select>
        </label>
      </div>
      {/* Honeypot (rule 27): hidden from people, filled by bots. */}
      <div aria-hidden="true" className="absolute -left-[9999px] h-0 overflow-hidden">
        <label>
          {t('website')}
          <input name="website" tabIndex={-1} autoComplete="off" />
        </label>
      </div>
      <TurnstileWidget siteKey={siteKey} nonce={nonce} onToken={setCaptcha} />
      <p className="text-xs text-text-muted">{t('sandboxNote')}</p>
      <button
        type="submit"
        disabled={busy || (Boolean(siteKey) && !captcha)}
        className="min-h-11 rounded-md bg-brand-green px-4 font-medium text-surface hover:bg-brand-green-deep disabled:opacity-60"
      >
        {t('submit')}
      </button>
    </form>
  );
}

const SR = 'sr-Latn';
const EN = 'en';
