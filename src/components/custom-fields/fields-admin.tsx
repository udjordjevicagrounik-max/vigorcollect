'use client';

import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { FormError, FormSuccess } from '@/components/auth/form-message';
import { useAction } from '@/components/admin/use-action';

// Admin → Settings → Fields (6.1). Add a field in one form; archive / restore instead of delete;
// key, type and personal-data class never change after creation.

type Def = {
  id: string;
  entityType: string;
  key: string;
  type: string;
  label: string;
  labels: Record<string, string>;
  piiClass: string;
  required: boolean;
  filterable: boolean;
  showInList: boolean;
  status: string;
  options: { code: string; label: string }[];
};

const ENTITIES = ['customer', 'contact', 'invoice', 'case'] as const;
const TYPES = ['text', 'number', 'date', 'bool', 'select', 'multiselect', 'currency'] as const;
const PII = ['P0', 'P1', 'P2', 'P3'] as const;
const field = 'min-h-11 rounded-md border border-border bg-surface px-3 text-text';
const label = 'flex flex-col gap-1 text-sm font-medium text-text';
const submit =
  'min-h-11 rounded-md bg-brand-green px-4 font-medium text-surface hover:bg-brand-green-deep disabled:opacity-60';
const secondary =
  'min-h-11 rounded-md border border-border bg-surface px-3 text-sm font-medium text-brand-purple disabled:opacity-60';

function parseOptions(text: string) {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [code = '', ...rest] = l.split(/\s+/);
      const name = rest.join(' ') || code;
      return { code: code.toLowerCase(), labels: { 'sr-Latn': name, en: name } };
    });
}

export function CustomFieldsAdmin({
  definitions,
  canManage,
  max,
}: {
  definitions: Def[];
  canManage: boolean;
  max: number;
}) {
  const t = useTranslations('customFields');
  const [entity, setEntity] = useState<(typeof ENTITIES)[number]>('customer');
  const [type, setType] = useState<(typeof TYPES)[number]>('text');
  const [pii, setPii] = useState<(typeof PII)[number]>('P0');
  const create = useAction();
  const edit = useAction();
  const list = definitions.filter((d) => d.entityType === entity);

  async function onCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    const ok = await create.run(
      'POST',
      '/api/custom-fields',
      {
        entityType: entity,
        key: String(f.get('key') ?? ''),
        type,
        piiClass: pii,
        labels: { 'sr-Latn': String(f.get('sr') ?? ''), en: String(f.get('en') ?? '') },
        required: f.get('required') === 'on',
        filterable: pii === 'P0' && f.get('filterable') === 'on',
        showInList: f.get('showInList') === 'on',
        options:
          type === 'select' || type === 'multiselect'
            ? parseOptions(String(f.get('options') ?? ''))
            : [],
      },
      t('admin.created'),
    );
    if (ok) event.currentTarget?.reset();
  }

  return (
    <div className="flex flex-col gap-4" data-fields-admin>
      <label className={`${label} max-w-xs`}>
        {t('admin.entity')}
        <select
          className={field}
          value={entity}
          onChange={(e) => setEntity(e.target.value as (typeof ENTITIES)[number])}
          data-fields-entity
        >
          {ENTITIES.map((e) => (
            <option key={e} value={e}>
              {t(`admin.entities.${e}`)}
            </option>
          ))}
        </select>
      </label>

      <section className="rounded-lg border border-border bg-surface p-4">
        {list.length === 0 ? (
          <p className="text-sm text-text-muted">{t('admin.empty')}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {list.map((d) => (
              <li
                key={d.id}
                className="flex flex-wrap items-center gap-2 border-b border-border pb-2 text-sm"
                data-field={d.key}
                data-status={d.status}
              >
                <span className="min-w-40 font-medium text-text">
                  {d.label}
                  <span className="block text-xs font-normal text-text-muted">
                    {d.key} · {t(`admin.types.${d.type as 'text'}`)} · {d.piiClass}
                    {d.status === 'archived' ? ` · ${t('admin.archived')}` : ''}
                  </span>
                </span>
                {canManage ? (
                  <>
                    <label className="flex min-h-11 items-center gap-1 text-xs text-text">
                      <input
                        type="checkbox"
                        defaultChecked={d.showInList}
                        className="size-5"
                        onChange={(e) =>
                          void edit.run(
                            'PUT',
                            `/api/custom-fields/${d.id}`,
                            { showInList: e.target.checked },
                            t('admin.updated'),
                          )
                        }
                      />
                      {t('admin.showInList')}
                    </label>
                    {d.piiClass === 'P0' ? (
                      <label className="flex min-h-11 items-center gap-1 text-xs text-text">
                        <input
                          type="checkbox"
                          defaultChecked={d.filterable}
                          className="size-5"
                          onChange={(e) =>
                            void edit.run(
                              'PUT',
                              `/api/custom-fields/${d.id}`,
                              { filterable: e.target.checked },
                              t('admin.updated'),
                            )
                          }
                        />
                        {t('admin.filterable')}
                      </label>
                    ) : null}
                    <button
                      type="button"
                      className={secondary}
                      disabled={edit.busy}
                      data-field-status
                      onClick={() =>
                        void edit.run(
                          'PUT',
                          `/api/custom-fields/${d.id}`,
                          { status: d.status === 'active' ? 'archived' : 'active' },
                          t('admin.updated'),
                        )
                      }
                    >
                      {d.status === 'active' ? t('admin.archive') : t('admin.restore')}
                    </button>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        <FormError problem={edit.problem} />
        <FormSuccess message={edit.notice} />
      </section>

      {canManage ? (
        <form
          onSubmit={(e) => void onCreate(e)}
          className="grid gap-3 rounded-lg border border-border bg-surface p-4 md:grid-cols-2"
          data-field-new
        >
          <label className={label}>
            {t('admin.labelSr')}
            <input name="sr" required maxLength={120} className={field} />
          </label>
          <label className={label}>
            {t('admin.labelEn')}
            <input name="en" required maxLength={120} className={field} />
          </label>
          <label className={label}>
            {t('admin.key')}
            <input name="key" required pattern="[a-z][a-z0-9_]{1,40}" className={field} />
          </label>
          <label className={label}>
            {t('admin.type')}
            <select
              className={field}
              value={type}
              onChange={(e) => setType(e.target.value as (typeof TYPES)[number])}
              data-field-type
            >
              {TYPES.map((x) => (
                <option key={x} value={x}>
                  {t(`admin.types.${x}`)}
                </option>
              ))}
            </select>
          </label>
          <label className={label}>
            {t('admin.piiClass')}
            <select
              className={field}
              value={pii}
              onChange={(e) => setPii(e.target.value as (typeof PII)[number])}
            >
              {PII.filter((p) => p === 'P0' || type === 'text').map((p) => (
                <option key={p} value={p}>
                  {t(`admin.pii.${p}`)}
                </option>
              ))}
            </select>
          </label>
          {type === 'select' || type === 'multiselect' ? (
            <label className={`${label} md:col-span-2`}>
              {t('admin.options')}
              <textarea
                name="options"
                rows={4}
                required
                className={`${field} py-2 font-mono text-sm`}
              />
            </label>
          ) : null}
          <div className="flex flex-wrap gap-4 md:col-span-2">
            <label className="flex min-h-11 items-center gap-2 text-sm text-text">
              <input type="checkbox" name="required" className="size-5" />
              {t('admin.requiredFlag')}
            </label>
            {pii === 'P0' ? (
              <label className="flex min-h-11 items-center gap-2 text-sm text-text">
                <input type="checkbox" name="filterable" className="size-5" />
                {t('admin.filterable')}
              </label>
            ) : null}
            <label className="flex min-h-11 items-center gap-2 text-sm text-text">
              <input type="checkbox" name="showInList" className="size-5" />
              {t('admin.showInList')}
            </label>
          </div>
          <div className="md:col-span-2">
            <button type="submit" className={submit} disabled={create.busy}>
              {t('admin.add')}
            </button>
            <p className="mt-1 text-xs text-text-muted">{t('admin.limit', { n: max })}</p>
            <FormError problem={create.problem} />
            <FormSuccess message={create.notice} />
          </div>
        </form>
      ) : null}
    </div>
  );
}
