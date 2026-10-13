'use client';

import { useTranslations } from 'next-intl';
import { type FormEvent } from 'react';
import { FormError } from '@/components/auth/form-message';
import { useAction } from '@/components/admin/use-action';

// Custom fields in a list (6.1): the member turns columns on/off (saved per member).

type Def = { id: string; label: string };

export function ColumnPicker({
  listKey,
  fields,
  chosen,
}: {
  listKey: 'customers' | 'invoices';
  fields: Def[];
  chosen: string[];
}) {
  const t = useTranslations('customFields');
  const { run, problem, busy } = useAction();
  if (fields.length === 0) return null;

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    await run(
      'PUT',
      '/api/list-columns',
      { listKey, fieldIds: f.getAll('field').map(String) },
      t('columnsSaved'),
    );
  }

  return (
    <details
      className="mt-3 rounded-lg border border-border bg-surface"
      data-column-picker={listKey}
    >
      <summary className="flex min-h-11 cursor-pointer items-center px-4 text-sm font-medium text-brand-purple">
        {t('columns')}
      </summary>
      <form
        onSubmit={(e) => void save(e)}
        className="flex flex-col gap-1 border-t border-border p-4"
      >
        {fields.map((f) => (
          <label key={f.id} className="flex min-h-11 items-center gap-2 text-sm text-text">
            <input
              type="checkbox"
              name="field"
              value={f.id}
              defaultChecked={chosen.includes(f.id)}
              className="size-5"
            />
            {f.label}
          </label>
        ))}
        <button
          type="submit"
          disabled={busy}
          className="mt-2 min-h-11 self-start rounded-md bg-brand-green px-4 font-medium text-surface disabled:opacity-60"
        >
          {t('save')}
        </button>
        <FormError problem={problem} />
      </form>
    </details>
  );
}
