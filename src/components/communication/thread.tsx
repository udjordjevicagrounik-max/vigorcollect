'use client';

import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { FormError, FormSuccess } from '@/components/auth/form-message';
import { useAction } from '@/components/admin/use-action';
import { UntrustedText } from './untrusted-text';

type Item = {
  id: string;
  direction: 'out' | 'in' | 'activity';
  at: string;
  kind: string;
  subject: string | null;
  text: string | null;
  status: string | null;
  address: string | null;
  caseId: string | null;
  actorName: string | null;
};
type Template = { key: string; name: string; hasLegalEffect: boolean };

const input = 'min-h-11 rounded-md border border-border bg-surface px-3 text-text';
const button =
  'min-h-11 rounded-md border border-brand-purple px-3 text-sm font-medium text-brand-purple hover:bg-brand-purple-soft disabled:opacity-60';

// Customer 360 → Communication (task 4.2): sent + received mail and logged activities, newest
// first; received text is untrusted (inert links); reply with a template or free text.
export function Thread({
  customerId,
  items,
  templates,
  canWrite,
}: {
  customerId: string;
  items: Item[];
  templates: Template[];
  canWrite: boolean;
}) {
  const t = useTranslations('communication');
  const { run, problem, notice, busy } = useAction();
  const [replyTo, setReplyTo] = useState<Item | null>(null);
  const [mode, setMode] = useState<'template' | 'free'>('free');

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const base = replyTo ? { replyToInboxId: replyTo.id } : {};
    const body =
      mode === 'template'
        ? { ...base, templateKey: String(form.get('template') ?? '') }
        : {
            ...base,
            subject: String(form.get('subject') ?? ''),
            body: String(form.get('body') ?? ''),
          };
    if (await run('POST', `/api/customers/${customerId}/messages`, body, t('sent')))
      setReplyTo(null);
  }

  return (
    <div className="flex flex-col gap-4" data-thread>
      <FormError problem={problem} />
      <FormSuccess message={notice} />
      {canWrite ? (
        <form
          onSubmit={send}
          className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4"
          data-message-form
        >
          <h2 className="font-semibold text-text">
            {replyTo ? t('replyTitle', { subject: replyTo.subject ?? '' }) : t('newTitle')}
          </h2>
          {replyTo ? (
            <button
              type="button"
              className="self-start text-sm text-brand-purple underline"
              onClick={() => setReplyTo(null)}
            >
              {t('cancelReply')}
            </button>
          ) : null}
          <fieldset className="flex flex-wrap gap-4">
            <label className="flex min-h-11 items-center gap-2 text-text">
              <input
                type="radio"
                name="mode"
                checked={mode === 'free'}
                onChange={() => setMode('free')}
              />{' '}
              {t('free')}
            </label>
            <label className="flex min-h-11 items-center gap-2 text-text">
              <input
                type="radio"
                name="mode"
                checked={mode === 'template'}
                onChange={() => setMode('template')}
              />{' '}
              {t('template')}
            </label>
          </fieldset>
          {mode === 'template' ? (
            <>
              <label htmlFor="msg-template" className="text-sm font-medium text-text">
                {t('template')}
              </label>
              <select id="msg-template" name="template" className={input}>
                {templates.map((x) => (
                  <option key={x.key} value={x.key}>
                    {x.name}
                    {x.hasLegalEffect ? ` · ${t('legalEffect')}` : ''}
                  </option>
                ))}
              </select>
            </>
          ) : (
            <>
              <label htmlFor="msg-subject" className="text-sm font-medium text-text">
                {t('subject')}
              </label>
              <input
                id="msg-subject"
                name="subject"
                required
                maxLength={300}
                defaultValue={replyTo?.subject ? `Re: ${replyTo.subject}` : ''}
                key={replyTo?.id ?? 'new'}
                className={input}
              />
              <label htmlFor="msg-body" className="text-sm font-medium text-text">
                {t('body')}
              </label>
              <textarea
                id="msg-body"
                name="body"
                required
                maxLength={20000}
                className="min-h-32 rounded-md border border-border bg-surface p-2 text-text"
              />
            </>
          )}
          <button type="submit" className={button} disabled={busy}>
            {t('send')}
          </button>
          <p className="text-xs text-text-muted">{t('sendHint')}</p>
        </form>
      ) : null}

      {items.length === 0 ? (
        <p className="rounded-lg border border-border bg-surface p-4 text-text-muted">
          {t('empty')}
        </p>
      ) : (
        <ol className="flex flex-col gap-2">
          {items.map((i) => (
            <li
              key={`${i.direction}-${i.id}`}
              data-thread-item={i.direction}
              className={`rounded-lg border p-3 ${i.direction === 'in' ? 'border-brand-purple bg-surface' : 'border-border bg-surface'}`}
            >
              <p className="text-xs text-text-muted">
                {i.at.slice(0, 16).replace('T', ' ')} · {t(`direction.${i.direction}`)}
                {i.direction === 'activity' ? ` · ${t(`activity.${i.kind as 'note'}`)}` : ''}
                {i.status ? ` · ${t(`status.${i.status as 'sent'}`)}` : ''}
                {i.address ? ` · ${i.address}` : ''}
                {i.actorName ? ` · ${i.actorName}` : ''}
              </p>
              {i.subject !== null ? <p className="font-medium text-text">{i.subject}</p> : null}
              {i.text !== null ? (
                i.direction === 'in' ? (
                  <UntrustedText text={i.text} />
                ) : (
                  <p className="whitespace-pre-wrap break-words text-sm text-text">{i.text}</p>
                )
              ) : null}
              {i.direction === 'in' && canWrite ? (
                <button
                  type="button"
                  className={`${button} mt-2`}
                  onClick={() => setReplyTo(i)}
                  data-reply={i.id}
                >
                  {t('reply')}
                </button>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
