'use client';

import { useTranslations } from 'next-intl';
import { type FormEvent } from 'react';
import { FormError, FormSuccess } from '@/components/auth/form-message';
import { useAction } from '@/components/admin/use-action';

// "Additional fields" (6.1) on any entity form: the tenant's custom fields, one input per type.
// Amounts stay decimal strings (rule 18); P1+ values are encrypted on the server.

type Def = {
  key: string;
  type: 'text' | 'number' | 'date' | 'bool' | 'select' | 'multiselect' | 'currency';
  label: string;
  required: boolean;
  piiClass: string;
  options: { code: string; label: string; active: boolean }[];
};
type Value = string | number | boolean | string[] | { amount: string; currency: string } | null;

const field = 'min-h-11 rounded-md border border-border bg-surface px-3 text-text';
const label = 'flex flex-col gap-1 text-sm font-medium text-text';

export function CustomFieldsPanel({
  entity,
  entityId,
  fields,
  values,
  canEdit,
  defaultCurrency,
}: {
  entity: 'customer' | 'contact' | 'invoice' | 'case';
  entityId: string;
  fields: Def[];
  values: Record<string, Value>;
  canEdit: boolean;
  defaultCurrency: string;
}) {
  const t = useTranslations('customFields');
  const { run, problem, notice, busy } = useAction();

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    const out: Record<string, unknown> = {};
    for (const d of fields) {
      const raw = f.get(d.key);
      if (d.type === 'bool') out[d.key] = f.get(d.key) === 'on';
      else if (d.type === 'multiselect') out[d.key] = f.getAll(d.key).map(String);
      else if (d.type === 'currency') {
        const amount = String(raw ?? '')
          .trim()
          .replace(',', '.');
        out[d.key] = amount
          ? { amount, currency: String(f.get(`${d.key}:currency`) || defaultCurrency) }
          : null;
      } else if (d.type === 'number') {
        const n = String(raw ?? '')
          .trim()
          .replace(',', '.');
        out[d.key] = n || null;
      } else out[d.key] = raw === null || raw === '' ? null : String(raw);
    }
    await run('PATCH', `/api/custom-fields/values/${entity}/${entityId}`, out, t('saved'));
  }

  return (
    <section className="rounded-lg border border-border bg-surface p-4" data-custom-fields={entity}>
      <h2 className="font-semibold text-brand-green">{t('panelTitle')}</h2>
      {fields.length === 0 ? (
        <p className="mt-1 max-w-prose text-sm text-text-muted">{t('panelEmpty')}</p>
      ) : (
        <form onSubmit={(e) => void save(e)} className="mt-3 grid gap-3 md:grid-cols-2">
          {fields.map((d) => {
            const v = values[d.key] ?? null;
            const hint = [
              d.required ? t('required') : null,
              d.piiClass !== 'P0' ? t('encrypted') : null,
            ]
              .filter(Boolean)
              .join(' · ');
            const caption = (
              <>
                {d.label}
                {hint ? <span className="text-xs font-normal text-text-muted">{hint}</span> : null}
              </>
            );
            if (d.type === 'bool')
              return (
                <label
                  key={d.key}
                  className="flex min-h-11 items-center gap-2 text-sm text-text"
                  data-cf={d.key}
                >
                  <input
                    type="checkbox"
                    name={d.key}
                    defaultChecked={v === true}
                    disabled={!canEdit}
                    className="size-5"
                  />
                  {caption}
                </label>
              );
            if (d.type === 'select')
              return (
                <label key={d.key} className={label} data-cf={d.key}>
                  {caption}
                  <select
                    name={d.key}
                    defaultValue={typeof v === 'string' ? v : ''}
                    disabled={!canEdit}
                    className={field}
                  >
                    <option value="">{t('choose')}</option>
                    {d.options.map((o) => (
                      <option key={o.code} value={o.code} disabled={!o.active}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
              );
            if (d.type === 'multiselect')
              return (
                <fieldset key={d.key} className="flex flex-col gap-1" data-cf={d.key}>
                  <legend className="text-sm font-medium text-text">{caption}</legend>
                  {d.options.map((o) => (
                    <label
                      key={o.code}
                      className="flex min-h-11 items-center gap-2 text-sm text-text"
                    >
                      <input
                        type="checkbox"
                        name={d.key}
                        value={o.code}
                        defaultChecked={Array.isArray(v) && v.includes(o.code)}
                        disabled={!canEdit || !o.active}
                        className="size-5"
                      />
                      {o.label}
                    </label>
                  ))}
                </fieldset>
              );
            if (d.type === 'currency') {
              const cur = v && typeof v === 'object' && !Array.isArray(v) ? v : null;
              return (
                <div key={d.key} className="flex gap-2" data-cf={d.key}>
                  <label className={`${label} flex-1`}>
                    {caption}
                    <input
                      name={d.key}
                      inputMode="decimal"
                      defaultValue={cur?.amount ?? ''}
                      disabled={!canEdit}
                      className={field}
                    />
                  </label>
                  <label className={label}>
                    {t('currency')}
                    <input
                      name={`${d.key}:currency`}
                      maxLength={3}
                      defaultValue={cur?.currency ?? defaultCurrency}
                      disabled={!canEdit}
                      className={`${field} w-20 uppercase`}
                    />
                  </label>
                </div>
              );
            }
            return (
              <label key={d.key} className={label} data-cf={d.key}>
                {caption}
                <input
                  name={d.key}
                  type={d.type === 'date' ? 'date' : 'text'}
                  inputMode={d.type === 'number' ? 'decimal' : undefined}
                  required={d.required}
                  defaultValue={typeof v === 'string' ? v : ''}
                  disabled={!canEdit}
                  className={field}
                />
              </label>
            );
          })}
          {canEdit ? (
            <div className="md:col-span-2">
              <button
                type="submit"
                disabled={busy}
                className="min-h-11 rounded-md bg-brand-green px-4 font-medium text-surface disabled:opacity-60"
              >
                {t('save')}
              </button>
              <FormError problem={problem} />
              <FormSuccess message={notice} />
            </div>
          ) : null}
        </form>
      )}
    </section>
  );
}
