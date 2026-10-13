'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { type FormEvent } from 'react';
import { FormError, FormSuccess } from '@/components/auth/form-message';
import { useAction } from '@/components/admin/use-action';

// Saved reports (5.2): own + shared in the tenant; "save as" stores the current filters,
// columns and sort (codes / dates only).

type Saved = { id: string; name: string; href: string; shared: boolean; mine: boolean };

export function SavedReports({
  reportKey,
  config,
  saved,
}: {
  reportKey: string;
  config: Record<string, unknown>;
  saved: Saved[];
}) {
  const t = useTranslations('reports');
  const { run, problem, notice, busy } = useAction();

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const ok = await run(
      'POST',
      '/api/reports/saved',
      {
        reportKey,
        name: String(form.get('name') ?? ''),
        shared: form.get('shared') === 'on',
        config,
      },
      t('savedOk'),
    );
    if (ok) event.currentTarget?.reset();
  }

  return (
    <section className="mt-4 rounded-lg border border-border bg-surface p-4" data-saved-reports>
      <h2 className="font-semibold text-brand-green">{t('saved')}</h2>
      {saved.length ? (
        <ul className="mt-2 flex flex-col gap-1">
          {saved.map((s) => (
            <li key={s.id} className="flex min-h-11 items-center gap-2 text-sm">
              <Link href={s.href} className="flex-1 text-brand-purple underline">
                {s.name}
              </Link>
              {s.shared ? <span className="text-xs text-text-muted">{t('sharedMark')}</span> : null}
              {s.mine ? (
                <button
                  type="button"
                  className="min-h-11 px-2 text-sm text-text-muted underline"
                  disabled={busy}
                  onClick={() => void run('DELETE', `/api/reports/saved/${s.id}`, {}, t('deleted'))}
                >
                  {t('delete')}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      <form onSubmit={save} className="mt-3 flex flex-wrap items-end gap-2">
        <label className="flex flex-1 flex-col gap-1 text-sm font-medium text-text">
          {t('saveAs')}
          <input
            name="name"
            required
            maxLength={120}
            className="min-h-11 rounded-md border border-border bg-surface px-3"
          />
        </label>
        <label className="flex min-h-11 items-center gap-2 text-sm text-text">
          <input type="checkbox" name="shared" className="size-5" />
          {t('share')}
        </label>
        <button
          type="submit"
          disabled={busy}
          className="min-h-11 rounded-md bg-brand-green px-4 font-medium text-surface disabled:opacity-60"
        >
          {t('save')}
        </button>
      </form>
      <FormError problem={problem} />
      <FormSuccess message={notice} />
    </section>
  );
}
