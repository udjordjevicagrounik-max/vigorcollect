'use client';

import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { FormError, FormSuccess } from '@/components/auth/form-message';
import { useAction } from '@/components/admin/use-action';
import { postJSON } from '@/lib/post-json';

// Platform → Tenants (6.4): the list (never business data, rule 32), "New tenant" in one form,
// and per tenant: lifecycle, flags, implementation tracker, data-package link.

type Tenant = {
  id: string;
  slug: string;
  name: string;
  lifecycle: string;
  isDemo: boolean;
  trialEndsAt: string | null;
  sandboxExpiresAt: string | null;
  contractSignedAt: string | null;
  users: number;
  lastActivity: string | null;
};

const field = 'min-h-11 rounded-md border border-border bg-surface px-3 text-text';
const label = 'flex flex-col gap-1 text-sm font-medium text-text';
const primary =
  'min-h-11 rounded-md bg-brand-green px-4 font-medium text-surface disabled:opacity-60';
const secondary =
  'min-h-11 rounded-md border border-border bg-surface px-3 text-sm font-medium text-brand-purple disabled:opacity-60';
const LIFECYCLES = ['trial', 'active', 'sandbox'] as const;
const POLICIES = ['standard', 'friendly', 'strict'] as const;
const LOCALES = ['sr-Latn', 'en'] as const;

export function TenantsAdmin({ tenants }: { tenants: Tenant[] }) {
  const t = useTranslations('platform');
  const locale = useLocale();
  const create = useAction();
  const date = (v: string | null) =>
    v ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(v)) : '—';

  async function onCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    const lifecycle = String(f.get('lifecycle'));
    const ok = await create.run(
      'POST',
      '/api/platform/tenants',
      {
        name: String(f.get('name')),
        slug: String(f.get('slug')),
        country: String(f.get('country')).toUpperCase(),
        locale: String(f.get('locale')),
        timezone: String(f.get('timezone')),
        currency: String(f.get('currency')).toUpperCase(),
        policy: String(f.get('policy')),
        lifecycle,
        trialDays: Number(f.get('trialDays') || 14),
        isDemo: lifecycle === 'sandbox' || f.get('isDemo') === 'on',
        companyName: String(f.get('companyName')),
        companyTaxId: String(f.get('companyTaxId')),
        owner: { email: String(f.get('ownerEmail')), displayName: String(f.get('ownerName')) },
      },
      t('created'),
    );
    if (ok) event.currentTarget?.reset();
  }

  return (
    <div className="flex flex-col gap-4">
      <ul className="flex flex-col gap-2" data-platform-tenants>
        {tenants.map((x) => (
          <li key={x.id}>
            <Link
              href={`/platform/tenants/${x.id}`}
              className="flex min-h-11 flex-col rounded-lg border border-border bg-surface p-3 hover:bg-brand-purple-soft md:flex-row md:items-center md:gap-4"
              data-tenant-row={x.slug}
            >
              <span className="font-medium text-text md:flex-1">{x.name}</span>
              <span className="text-sm text-text-muted">
                {t(`lifecycle.${x.lifecycle as 'trial'}`)}
                {x.lifecycle === 'trial' ? ` · ${t('until', { date: date(x.trialEndsAt) })}` : ''}
                {x.lifecycle === 'sandbox'
                  ? ` · ${t('until', { date: date(x.sandboxExpiresAt) })}`
                  : ''}
                {x.contractSignedAt ? ` · ${t('contract')}` : ''}
              </span>
              <span className="text-sm text-text-muted">
                {t('users', { n: x.users })} · {t('lastActivity', { date: date(x.lastActivity) })}
              </span>
            </Link>
          </li>
        ))}
      </ul>
      <details className="rounded-lg border border-border bg-surface" data-tenant-new>
        <summary className="flex min-h-11 cursor-pointer items-center px-4 font-medium text-brand-purple">
          {t('new')}
        </summary>
        <form
          onSubmit={(e) => void onCreate(e)}
          className="grid gap-3 border-t border-border p-4 md:grid-cols-2"
        >
          <label className={label}>
            {t('fields.name')}
            <input name="name" required minLength={2} className={field} />
          </label>
          <label className={label}>
            {t('fields.slug')}
            <input name="slug" required pattern="[a-z0-9][a-z0-9-]{1,40}" className={field} />
          </label>
          <label className={label}>
            {t('fields.companyName')}
            <input name="companyName" required minLength={2} className={field} />
          </label>
          <label className={label}>
            {t('fields.companyTaxId')}
            <input name="companyTaxId" required className={field} />
          </label>
          <label className={label}>
            {t('fields.country')}
            <input name="country" required defaultValue={RS} maxLength={2} className={field} />
          </label>
          <label className={label}>
            {t('fields.locale')}
            <select name="locale" className={field}>
              {LOCALES.map((l) => (
                <option key={l} value={l}>
                  {t(`locales.${l === 'en' ? 'en' : 'sr'}`)}
                </option>
              ))}
            </select>
          </label>
          <label className={label}>
            {t('fields.timezone')}
            <input name="timezone" required defaultValue={BELGRADE} className={field} />
          </label>
          <label className={label}>
            {t('fields.currency')}
            <input name="currency" required defaultValue={RSD} maxLength={3} className={field} />
          </label>
          <label className={label}>
            {t('fields.policy')}
            <select name="policy" className={field}>
              {POLICIES.map((p) => (
                <option key={p} value={p}>
                  {t(`policies.${p}`)}
                </option>
              ))}
            </select>
          </label>
          <label className={label}>
            {t('fields.lifecycle')}
            <select name="lifecycle" className={field}>
              {LIFECYCLES.map((l) => (
                <option key={l} value={l}>
                  {t(`lifecycle.${l}`)}
                </option>
              ))}
            </select>
          </label>
          <label className={label}>
            {t('fields.trialDays')}
            <input
              name="trialDays"
              type="number"
              min={1}
              max={90}
              defaultValue={14}
              className={field}
            />
          </label>
          <label className="flex min-h-11 items-center gap-2 text-sm text-text">
            <input type="checkbox" name="isDemo" className="size-5" />
            {t('fields.isDemo')}
          </label>
          <label className={label}>
            {t('fields.ownerName')}
            <input name="ownerName" required className={field} />
          </label>
          <label className={label}>
            {t('fields.ownerEmail')}
            <input name="ownerEmail" type="email" required className={field} />
          </label>
          <div className="md:col-span-2">
            <button type="submit" className={primary} disabled={create.busy}>
              {t('create')}
            </button>
            <FormError problem={create.problem} />
            <FormSuccess message={create.notice} />
          </div>
        </form>
      </details>
    </div>
  );
}

type Flag = { key: string; platformEnabled: boolean; enabled: boolean };
type Tracker = {
  steps: Record<string, string | null>;
  hoursSinceData: number | null;
  slaBreached: boolean;
};
const STEPS = [
  'data_received',
  'import_done',
  'mailbox_done',
  'bank_done',
  'rules_done',
  'training_done',
  'go_live',
] as const;

export function TenantDetail({
  tenant,
  flags,
  tracker,
}: {
  tenant: Tenant;
  flags: Flag[];
  tracker: Tracker;
}) {
  const t = useTranslations('platform');
  const locale = useLocale();
  const act = useAction();
  const [link, setLink] = useState<string | null>(null);
  const base = `/api/platform/tenants/${tenant.id}`;
  const date = (v: string | null) =>
    v
      ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
          new Date(v),
        )
      : '—';

  return (
    <div className="flex flex-col gap-4" data-tenant-detail={tenant.slug}>
      <section className="rounded-lg border border-border bg-surface p-4">
        <h2 className="font-semibold text-brand-green">{t('lifecycleTitle')}</h2>
        <p className="mt-1 text-sm text-text-muted">
          {t(`lifecycle.${tenant.lifecycle as 'trial'}`)}
          {tenant.contractSignedAt ? ` · ${t('contract')}` : ''}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {tenant.lifecycle === 'sandbox' ? (
            <button
              type="button"
              className={secondary}
              data-convert-trial
              onClick={() =>
                void act.run(
                  'PUT',
                  `${base}/lifecycle`,
                  { status: 'trial', trialDays: 14 },
                  t('saved'),
                )
              }
            >
              {t('toTrial')}
            </button>
          ) : null}
          {tenant.lifecycle !== 'active' ? (
            <button
              type="button"
              className={secondary}
              onClick={() =>
                void act.run('PUT', `${base}/lifecycle`, { status: 'active' }, t('saved'))
              }
            >
              {t('activate')}
            </button>
          ) : null}
          {!tenant.contractSignedAt ? (
            <button
              type="button"
              className={secondary}
              onClick={() =>
                void act.run('PUT', `${base}/lifecycle`, { contractSigned: true }, t('saved'))
              }
            >
              {t('contractSigned')}
            </button>
          ) : null}
          {tenant.lifecycle !== 'suspended' ? (
            <button
              type="button"
              className={secondary}
              onClick={() =>
                void act.run('PUT', `${base}/lifecycle`, { status: 'suspended' }, t('saved'))
              }
            >
              {t('suspend')}
            </button>
          ) : null}
        </div>
      </section>

      <section className="rounded-lg border border-border bg-surface p-4" data-tracker>
        <h2 className="font-semibold text-brand-green">{t('trackerTitle')}</h2>
        <p
          className={`mt-1 text-sm ${tracker.slaBreached ? 'text-status-danger-fg' : 'text-text-muted'}`}
        >
          {tracker.hoursSinceData === null
            ? t('slaNotStarted')
            : t('slaHours', { hours: tracker.hoursSinceData })}
        </p>
        <ul className="mt-2 flex flex-col gap-1">
          {STEPS.map((s) => (
            <li key={s}>
              <label className="flex min-h-11 items-center gap-2 text-sm text-text">
                <input
                  type="checkbox"
                  className="size-5"
                  defaultChecked={Boolean(tracker.steps[s])}
                  onChange={(e) =>
                    void act.run(
                      'PUT',
                      `${base}/tracker`,
                      { step: s, done: e.target.checked },
                      t('saved'),
                    )
                  }
                />
                {t(`steps.${s}`)}
                <span className="text-xs text-text-muted">{date(tracker.steps[s] ?? null)}</span>
              </label>
            </li>
          ))}
        </ul>
        <button
          type="button"
          className={`${secondary} mt-3`}
          data-package-link
          onClick={async () => {
            const res = await postJSON(`${base}/package`, {});
            if (res.status === 201) setLink((res.json as { url: string }).url);
          }}
        >
          {t('packageLink')}
        </button>
        {link ? (
          <p
            className="mt-2 break-all rounded-md bg-brand-purple-soft p-2 text-sm text-text"
            data-package-url
          >
            {link}
          </p>
        ) : null}
      </section>

      <section className="rounded-lg border border-border bg-surface p-4">
        <h2 className="font-semibold text-brand-green">{t('flagsTitle')}</h2>
        {flags.length === 0 ? <p className="text-sm text-text-muted">{t('noFlags')}</p> : null}
        <ul className="mt-2 flex flex-col gap-1">
          {flags.map((f) => (
            <li key={f.key}>
              <label className="flex min-h-11 items-center gap-2 text-sm text-text">
                <input
                  type="checkbox"
                  className="size-5"
                  defaultChecked={f.enabled}
                  disabled={!f.platformEnabled}
                  onChange={(e) =>
                    void act.run(
                      'PUT',
                      `${base}/flags`,
                      { key: f.key, enabled: e.target.checked },
                      t('saved'),
                    )
                  }
                />
                <code className="text-xs">{f.key}</code>
                {!f.platformEnabled ? (
                  <span className="text-xs text-text-muted">{t('platformOff')}</span>
                ) : null}
              </label>
            </li>
          ))}
        </ul>
      </section>
      <FormError problem={act.problem} />
      <FormSuccess message={act.notice} />
    </div>
  );
}

const RS = 'RS';
const RSD = 'RSD';
const BELGRADE = 'Europe/Belgrade';
