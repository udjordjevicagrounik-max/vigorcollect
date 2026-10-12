'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { FormError } from '@/components/auth/form-message';
import { useAction } from '@/components/admin/use-action';

type Filter = {
  q?: string | undefined;
  overdue?: '1' | undefined;
  owner?: 'me' | 'none' | undefined;
  status?: string | undefined;
};

const href = (f: Filter) =>
  `/customers?${new URLSearchParams(
    Object.entries(f).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== ''),
  ).toString()}`;

// Saved customer-list filters of the member (private): apply = a link, save the current one,
// delete with an in-page confirmation.
export function SavedFilters({
  current,
  saved,
}: {
  current: Filter;
  saved: { id: string; name: string; filter: Filter }[];
}) {
  const t = useTranslations('customers.saved');
  const { run, problem, busy } = useAction();
  const [confirm, setConfirm] = useState<string | null>(null);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const name = String(new FormData(form).get('name') ?? '');
    if (await run('POST', '/api/saved-filters', { name, filter: current }, t('savedNotice')))
      form.reset();
  }

  async function remove(id: string) {
    await run('DELETE', `/api/saved-filters/${id}`, {}, t('deletedNotice'));
    setConfirm(null);
  }

  return (
    <section aria-label={t('label')} className="mt-3 flex flex-col gap-2">
      <FormError problem={problem} />
      {saved.length ? (
        <ul className="flex flex-wrap gap-2 text-sm">
          {saved.map((f) => (
            <li
              key={f.id}
              className="flex items-center gap-1 rounded-md border border-border bg-surface pl-3"
              data-saved-filter={f.name}
            >
              <Link
                href={href(f.filter)}
                className="inline-flex min-h-11 items-center text-brand-purple underline"
              >
                {f.name}
              </Link>
              {confirm === f.id ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void remove(f.id)}
                  className="min-h-11 px-2 text-status-danger-fg"
                >
                  {t('confirmDelete')}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirm(f.id)}
                  aria-label={t('delete', { name: f.name })}
                  className="min-h-11 px-2 text-text-muted"
                >
                  {t('deleteShort')}
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      <form onSubmit={save} className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-sm font-medium text-text">
          {t('name')}
          <input
            name="name"
            required
            maxLength={80}
            autoComplete="off"
            className="min-h-11 rounded-md border border-border bg-surface px-3"
          />
        </label>
        <button
          type="submit"
          disabled={busy}
          className="min-h-11 rounded-md border border-brand-purple px-3 text-sm font-medium text-brand-purple hover:bg-brand-purple-soft disabled:opacity-60"
        >
          {t('save')}
        </button>
      </form>
    </section>
  );
}
