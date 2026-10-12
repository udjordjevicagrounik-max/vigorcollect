'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { FormError, FormSuccess } from '@/components/auth/form-message';
import { useAction } from '@/components/admin/use-action';

type Text = { locale: string; subject: string; body: string };

// Edits the texts of one template; saving creates a NEW version (variables and tags are
// checked on the server against the whitelist).
export function TemplateEditor({
  id,
  texts,
  editable,
}: {
  id: string;
  texts: Text[];
  editable: boolean;
}) {
  const t = useTranslations('templatesAdmin');
  const { run, problem, notice, busy } = useAction();
  const [draft, setDraft] = useState<Text[]>(texts);
  const set = (i: number, patch: Partial<Text>) =>
    setDraft(draft.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void run('PUT', `/api/templates/${id}`, { texts: draft }, t('saved'));
      }}
    >
      <FormError problem={problem} />
      <FormSuccess message={notice} />
      <fieldset disabled={!editable || busy} className="flex flex-col gap-3">
        {draft.map((x, i) => (
          <div key={x.locale} className="flex flex-col gap-2" data-template-locale={x.locale}>
            <label className="flex flex-col gap-1 text-sm font-medium text-text">
              {t('subject', { locale: x.locale })}
              <input
                className="min-h-11 rounded-md border border-border bg-surface px-3"
                value={x.subject}
                onChange={(e) => set(i, { subject: e.target.value })}
                required
                maxLength={300}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm font-medium text-text">
              {t('body', { locale: x.locale })}
              <textarea
                className="min-h-40 rounded-md border border-border bg-surface p-2 font-mono text-xs"
                value={x.body}
                onChange={(e) => set(i, { body: e.target.value })}
                required
                maxLength={20000}
              />
            </label>
          </div>
        ))}
      </fieldset>
      {editable ? (
        <button
          type="submit"
          disabled={busy}
          className="min-h-11 self-start rounded-md bg-brand-green px-4 font-medium text-surface hover:bg-brand-green-deep disabled:opacity-60"
        >
          {t('save')}
        </button>
      ) : null}
    </form>
  );
}
