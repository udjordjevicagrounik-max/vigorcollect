'use client';

import { useTranslations } from 'next-intl';
import { FormError, FormSuccess } from '@/components/auth/form-message';
import { useAction } from './use-action';

type Message = { id: string; receivedAt: string; subject: string; sender: string };

const button =
  'min-h-11 rounded-md border border-brand-purple px-3 text-sm font-medium text-brand-purple hover:bg-brand-purple-soft disabled:opacity-60';

// Admin → Integrations → Unlinked messages (task 4.2): received mail no rule could match to a
// customer — a person links it (or ignores it). The subject is untrusted text, shown as text.
export function UnlinkedMessages({
  messages,
  customers,
  canManage,
}: {
  messages: Message[];
  customers: { id: string; name: string }[];
  canManage: boolean;
}) {
  const t = useTranslations('communication');
  const { run, problem, notice, busy } = useAction();
  return (
    <section aria-labelledby="unlinked-title" className="mt-6 flex flex-col gap-2" data-unlinked>
      <h2 id="unlinked-title" className="font-semibold text-text">
        {t('unlinkedTitle')}
      </h2>
      <p className="text-sm text-text-muted">{t('unlinkedDescription')}</p>
      <FormError problem={problem} />
      <FormSuccess message={notice} />
      {messages.length === 0 ? (
        <p className="rounded-lg border border-border bg-surface p-4 text-text-muted">
          {t('unlinkedEmpty')}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {messages.map((m) => (
            <li
              key={m.id}
              data-unlinked-message={m.id}
              className="rounded-md border border-border bg-surface p-3"
            >
              <p className="break-words text-sm font-medium text-text">
                {m.subject || t('noSubject')}
              </p>
              <p className="text-xs text-text-muted">
                {m.sender} · {m.receivedAt.slice(0, 16).replace('T', ' ')}
              </p>
              {canManage ? (
                <form
                  className="mt-2 flex flex-wrap gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const customerId = String(new FormData(e.currentTarget).get('customer') ?? '');
                    void run('POST', `/api/mail-inbox/${m.id}/link`, { customerId }, t('linked'));
                  }}
                >
                  <label htmlFor={`link-${m.id}`} className="sr-only">
                    {t('customer')}
                  </label>
                  <select
                    id={`link-${m.id}`}
                    name="customer"
                    required
                    className="min-h-11 min-w-0 flex-1 rounded-md border border-border bg-surface px-3 text-text"
                  >
                    {customers.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                  <button
                    type="submit"
                    className={button}
                    disabled={busy || customers.length === 0}
                  >
                    {t('link')}
                  </button>
                  <button
                    type="button"
                    className={button}
                    disabled={busy}
                    onClick={() =>
                      void run(
                        'POST',
                        `/api/mail-inbox/${m.id}/link`,
                        { ignore: true },
                        t('ignored'),
                      )
                    }
                  >
                    {t('ignore')}
                  </button>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
