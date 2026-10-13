'use client';

import { useTranslations } from 'next-intl';
import { type FormEvent } from 'react';
import { FormError, FormSuccess } from '@/components/auth/form-message';
import { useAction } from '@/components/admin/use-action';

// Admin → Settings, configuration (5.2). Code lists are edited, never deleted: "remove" is
// "inactive" (rows keep referencing the code). Every save is audited with a domain event.

type Code = {
  code: string;
  labels: Record<string, string>;
  active: boolean;
  system: boolean;
  sortOrder: number;
  inUse: boolean;
};
type Bound = { code: string; min: number; max: number | null };
type Thresholds = {
  attentionNoActivityDays: number;
  attentionLargeOverdue: string | null;
  riskWeights: Record<string, number>;
  riskBandYellow: number;
  riskBandRed: number;
  defaultPolicyCode: string;
  bulkMaxItems: number;
};
type Calendar = {
  companyId: string;
  name: string;
  workingDays: number[];
  holidays: { date: string; name: string }[];
};

const field = 'min-h-11 rounded-md border border-border bg-surface px-3 text-text';
const small = 'min-h-11 w-24 rounded-md border border-border bg-surface px-2 text-text';
const label = 'flex flex-col gap-1 text-sm font-medium text-text';
const submit =
  'min-h-11 rounded-md bg-brand-green px-4 font-medium text-surface hover:bg-brand-green-deep disabled:opacity-60';
const card = 'rounded-lg border border-border bg-surface p-4';
const DAYS = [1, 2, 3, 4, 5, 6, 7] as const;
const ON = 'on';
const LISTS = ['collection_policy', 'case_stage', 'dispute_reason', 'payment_behaviour'] as const;

function Section({
  title,
  children,
  id,
}: {
  title: string;
  children: React.ReactNode;
  id: string;
}) {
  return (
    <section className={card} data-config-section={id}>
      <h2 className="font-semibold text-brand-green">{title}</h2>
      <div className="mt-3 flex flex-col gap-3">{children}</div>
    </section>
  );
}

function CodeList({
  listKey,
  codes,
  canManage,
}: {
  listKey: (typeof LISTS)[number];
  codes: Code[];
  canManage: boolean;
}) {
  const t = useTranslations('admin.configuration');
  const { run, problem, notice, busy } = useAction();

  async function save(event: FormEvent<HTMLFormElement>, code?: string) {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    await run(
      'PUT',
      `/api/settings/code-lists/${listKey}`,
      {
        code: code ?? String(f.get('code') ?? ''),
        labels: { 'sr-Latn': String(f.get('sr') ?? ''), en: String(f.get('en') ?? '') },
        active: f.get('active') === 'on',
        sortOrder: Number(f.get('sortOrder') ?? 100),
      },
      t('saved'),
    );
  }

  return (
    <Section title={t(`lists.${listKey}`)} id={listKey}>
      <ul className="flex flex-col gap-2">
        {codes.map((c) => (
          <li key={c.code} data-code={c.code}>
            <form
              onSubmit={(e) => void save(e, c.code)}
              className="flex flex-wrap items-end gap-2 border-b border-border pb-2"
            >
              <span className="min-w-28 text-sm font-medium text-text">
                {c.code}
                {c.inUse ? (
                  <span className="block text-xs text-text-muted">{t('inUse')}</span>
                ) : null}
              </span>
              <label className={label}>
                {t('labelSr')}
                <input
                  name="sr"
                  defaultValue={c.labels['sr-Latn'] ?? ''}
                  required
                  className={field}
                  disabled={!canManage}
                />
              </label>
              <label className={label}>
                {t('labelEn')}
                <input
                  name="en"
                  defaultValue={c.labels.en ?? ''}
                  required
                  className={field}
                  disabled={!canManage}
                />
              </label>
              <label className={label}>
                {t('order')}
                <input
                  name="sortOrder"
                  type="number"
                  min={0}
                  max={999}
                  defaultValue={c.sortOrder}
                  className={small}
                  disabled={!canManage}
                />
              </label>
              <label className="flex min-h-11 items-center gap-2 text-sm text-text">
                <input
                  type="checkbox"
                  name="active"
                  defaultChecked={c.active}
                  className="size-5"
                  disabled={!canManage}
                />
                {t('active')}
              </label>
              {canManage ? (
                <button type="submit" className={submit} disabled={busy}>
                  {t('save')}
                </button>
              ) : null}
            </form>
          </li>
        ))}
      </ul>
      {canManage ? (
        <form
          onSubmit={(e) => void save(e)}
          className="flex flex-wrap items-end gap-2"
          data-code-new
        >
          <label className={label}>
            {t('newCode')}
            <input name="code" required pattern="[a-z][a-z0-9_]{0,40}" className={field} />
          </label>
          <label className={label}>
            {t('labelSr')}
            <input name="sr" required className={field} />
          </label>
          <label className={label}>
            {t('labelEn')}
            <input name="en" required className={field} />
          </label>
          <input type="hidden" name="active" value={ON} />
          <input type="hidden" name="sortOrder" value="100" />
          <button type="submit" className={submit} disabled={busy}>
            {t('add')}
          </button>
        </form>
      ) : null}
      <p className="text-xs text-text-muted">{t('neverDeleted')}</p>
      <FormError problem={problem} />
      <FormSuccess message={notice} />
    </Section>
  );
}

export function ConfigurationAdmin({
  canManage,
  lists,
  bounds,
  bucketLabels,
  thresholds,
  policies,
  calendars,
}: {
  canManage: boolean;
  lists: Record<(typeof LISTS)[number], Code[]>;
  bounds: Bound[];
  bucketLabels: Record<string, string>;
  thresholds: Thresholds;
  policies: { code: string; label: string }[];
  calendars: Calendar[];
}) {
  const t = useTranslations('admin.configuration');
  const tDays = useTranslations('admin.configuration.days');
  const tRisk = useTranslations('admin.configuration.riskFactors');
  const aging = useAction();
  const limits = useAction();
  const calendar = useAction();

  async function saveBounds(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    await aging.run(
      'PUT',
      '/api/settings/aging-buckets',
      bounds.map((b) => ({
        code: b.code,
        min: Number(f.get(`min:${b.code}`) ?? 0),
        max: f.get(`max:${b.code}`) === '' ? null : Number(f.get(`max:${b.code}`)),
      })),
      t('saved'),
    );
  }

  async function saveThresholds(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    const large = String(f.get('large') ?? '').trim();
    await limits.run(
      'PUT',
      '/api/settings/thresholds',
      {
        attentionNoActivityDays: Number(f.get('noActivity')),
        attentionLargeOverdue: large === '' ? null : large,
        riskWeights: Object.fromEntries(
          Object.keys(thresholds.riskWeights).map((k) => [k, Number(f.get(`w:${k}`))]),
        ),
        riskBandYellow: Number(f.get('yellow')),
        riskBandRed: Number(f.get('red')),
        defaultPolicyCode: String(f.get('policy')),
        bulkMaxItems: Number(f.get('bulk')),
      },
      t('saved'),
    );
  }

  async function saveCalendar(event: FormEvent<HTMLFormElement>, companyId: string) {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    const holidays = String(f.get('holidays') ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => ({ date: l.slice(0, 10), name: l.slice(10).trim() || l.slice(0, 10) }));
    await calendar.run(
      'PUT',
      `/api/settings/calendars/${companyId}`,
      { workingDays: f.getAll('day').map(Number), holidays },
      t('saved'),
    );
  }

  return (
    <div className="mt-6 flex flex-col gap-4" data-configuration>
      <Section title={t('aging')} id="aging">
        <form onSubmit={(e) => void saveBounds(e)} className="flex flex-col gap-2">
          {bounds.map((b) => (
            <div key={b.code} className="flex flex-wrap items-end gap-2" data-bucket={b.code}>
              <span className="min-w-36 text-sm font-medium text-text">
                {bucketLabels[b.code] ?? b.code}
              </span>
              <label className={label}>
                {t('minDays')}
                <input
                  name={`min:${b.code}`}
                  type="number"
                  min={0}
                  defaultValue={b.min}
                  className={small}
                  disabled={!canManage}
                />
              </label>
              <label className={label}>
                {t('maxDays')}
                <input
                  name={`max:${b.code}`}
                  type="number"
                  min={0}
                  defaultValue={b.max ?? ''}
                  className={small}
                  disabled={!canManage}
                />
              </label>
            </div>
          ))}
          <p className="text-xs text-text-muted">{t('agingHint')}</p>
          {canManage ? (
            <button type="submit" className={`${submit} self-start`} disabled={aging.busy}>
              {t('save')}
            </button>
          ) : null}
          <FormError problem={aging.problem} />
          <FormSuccess message={aging.notice} />
        </form>
      </Section>

      {LISTS.map((k) => (
        <CodeList key={k} listKey={k} codes={lists[k]} canManage={canManage} />
      ))}

      <Section title={t('thresholds')} id="thresholds">
        <form onSubmit={(e) => void saveThresholds(e)} className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-3">
            <label className={label}>
              {t('noActivityDays')}
              <input
                name="noActivity"
                type="number"
                min={1}
                max={365}
                defaultValue={thresholds.attentionNoActivityDays}
                className={small}
                disabled={!canManage}
              />
            </label>
            <label className={label}>
              {t('largeOverdue')}
              <input
                name="large"
                inputMode="decimal"
                pattern="\d{1,16}(\.\d{1,2})?"
                defaultValue={thresholds.attentionLargeOverdue ?? ''}
                className={field}
                disabled={!canManage}
              />
            </label>
            <label className={label}>
              {t('defaultPolicy')}
              <select
                name="policy"
                defaultValue={thresholds.defaultPolicyCode}
                className={field}
                disabled={!canManage}
              >
                {policies.map((p) => (
                  <option key={p.code} value={p.code}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            <label className={label}>
              {t('bulkMax')}
              <input
                name="bulk"
                type="number"
                min={1}
                max={5000}
                defaultValue={thresholds.bulkMaxItems}
                className={small}
                disabled={!canManage}
              />
            </label>
          </div>
          <fieldset className="flex flex-wrap gap-3">
            <legend className="text-sm font-medium text-text">{t('riskWeights')}</legend>
            {Object.entries(thresholds.riskWeights).map(([k, v]) => (
              <label key={k} className={label}>
                {tRisk(k as 'days_overdue')}
                <input
                  name={`w:${k}`}
                  type="number"
                  min={0}
                  max={100}
                  defaultValue={v}
                  className={small}
                  disabled={!canManage}
                />
              </label>
            ))}
          </fieldset>
          <div className="flex flex-wrap gap-3">
            <label className={label}>
              {t('bandYellow')}
              <input
                name="yellow"
                type="number"
                min={1}
                max={99}
                defaultValue={thresholds.riskBandYellow}
                className={small}
                disabled={!canManage}
              />
            </label>
            <label className={label}>
              {t('bandRed')}
              <input
                name="red"
                type="number"
                min={2}
                max={100}
                defaultValue={thresholds.riskBandRed}
                className={small}
                disabled={!canManage}
              />
            </label>
          </div>
          {canManage ? (
            <button type="submit" className={`${submit} self-start`} disabled={limits.busy}>
              {t('save')}
            </button>
          ) : null}
          <FormError problem={limits.problem} />
          <FormSuccess message={limits.notice} />
        </form>
      </Section>

      <Section title={t('calendar')} id="calendar">
        {calendars.map((c) => (
          <form
            key={c.companyId}
            onSubmit={(e) => void saveCalendar(e, c.companyId)}
            className="flex flex-col gap-2 border-b border-border pb-3"
            data-calendar={c.companyId}
          >
            <p className="font-medium text-text">{c.name}</p>
            <fieldset className="flex flex-wrap gap-3">
              <legend className="text-sm text-text-muted">{t('workingDays')}</legend>
              {DAYS.map((d) => (
                <label key={d} className="flex min-h-11 items-center gap-1 text-sm text-text">
                  <input
                    type="checkbox"
                    name="day"
                    value={d}
                    defaultChecked={c.workingDays.includes(d)}
                    className="size-5"
                    disabled={!canManage}
                  />
                  {tDays(String(d) as '1')}
                </label>
              ))}
            </fieldset>
            <label className={label}>
              {t('holidays')}
              <textarea
                name="holidays"
                rows={4}
                defaultValue={c.holidays.map((h) => `${h.date} ${h.name}`).join('\n')}
                className={`${field} py-2 font-mono text-sm`}
                disabled={!canManage}
              />
            </label>
            {canManage ? (
              <button type="submit" className={`${submit} self-start`} disabled={calendar.busy}>
                {t('save')}
              </button>
            ) : null}
          </form>
        ))}
        <FormError problem={calendar.problem} />
        <FormSuccess message={calendar.notice} />
      </Section>
    </div>
  );
}
