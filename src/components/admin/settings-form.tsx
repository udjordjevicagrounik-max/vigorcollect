'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { FormError, FormSuccess, type FormProblem } from '@/components/auth/form-message';
import { SubmitButton } from '@/components/auth/field';
import { LOCALES } from '@/i18n/config';
import { apiProblem } from '@/lib/api-problem';
import { sendJSON } from '@/lib/post-json';

type Settings = {
  tenantName: string;
  defaultLocale: string;
  timezone: string;
  defaultCurrency: string;
  countryCode: string;
};

function Select({
  id,
  label,
  value,
  options,
  disabled,
}: {
  id: string;
  label: string;
  value: string;
  options: { value: string; label: string }[];
  disabled: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium text-text">
        {label}
      </label>
      <select
        id={id}
        name={id}
        defaultValue={value}
        disabled={disabled}
        className="min-h-11 rounded-md border border-border bg-surface px-3 text-text disabled:opacity-70"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

// Tenant settings form (mobile-full). Read-only without settings.manage.
export function SettingsForm({
  settings,
  countries,
  canManage,
  timezones,
  currencies,
}: {
  settings: Settings;
  countries: string[];
  canManage: boolean;
  timezones: string[];
  currencies: string[];
}) {
  const t = useTranslations('admin.settings');
  const tErrors = useTranslations('errors');
  const router = useRouter();
  const [problem, setProblem] = useState<FormProblem | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);
  const opts = (values: string[]) => values.map((v) => ({ value: v, label: v }));

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setProblem(null);
    setSaved(false);
    const res = await sendJSON('PUT', '/api/settings/tenant', {
      defaultLocale: String(form.get('locale') ?? ''),
      timezone: String(form.get('timezone') ?? ''),
      defaultCurrency: String(form.get('currency') ?? ''),
      countryCode: String(form.get('country') ?? ''),
    });
    setPending(false);
    if (res.status === 200) {
      setSaved(true);
      router.refresh();
    } else setProblem(apiProblem(res, tErrors));
  }

  return (
    <form onSubmit={onSubmit} className="flex max-w-md flex-col gap-4">
      {!canManage ? <p className="text-sm text-text-muted">{t('readOnly')}</p> : null}
      <Select
        id="locale"
        label={t('locale')}
        value={settings.defaultLocale}
        disabled={!canManage}
        options={LOCALES.map((l) => ({ value: l, label: t(`locales.${l}`) }))}
      />
      <Select
        id="timezone"
        label={t('timezone')}
        value={settings.timezone}
        disabled={!canManage}
        options={opts(timezones)}
      />
      <Select
        id="currency"
        label={t('currency')}
        value={settings.defaultCurrency}
        disabled={!canManage}
        options={opts(currencies)}
      />
      <Select
        id="country"
        label={t('country')}
        value={settings.countryCode}
        disabled={!canManage}
        options={opts(countries)}
      />
      <FormError problem={problem} />
      <FormSuccess message={saved ? t('saved') : null} />
      {canManage ? <SubmitButton label={t('save')} pending={pending} /> : null}
    </form>
  );
}
