'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useState, type FormEvent, type ReactNode } from 'react';
import { FormError, FormSuccess } from '@/components/auth/form-message';
import { useAction } from '@/components/admin/use-action';
import { formatAmount } from '@/lib/format-amount';

// Actions on a customer (task 2.4): open a case with chosen invoices, record a promise, log an
// activity, mark a payment. Each form is a disclosure (compact on a phone); the server checks
// permission + scope again — the buttons only follow the member's permissions.

type OpenInvoice = {
  id: string;
  number: string;
  amountOpen: string;
  currency: string;
  dueDate: string;
};

const PERM = {
  case: 'case.create',
  promise: 'promise.create',
  activity: 'activity.create',
  payment: 'payment.create',
} as const;
const ACTIVITY_KINDS = ['call', 'email', 'note', 'meeting'] as const;
const PRIORITIES = ['normal', 'high', 'urgent', 'low'] as const;
const field = 'min-h-11 rounded-md border border-border bg-surface px-3 text-text';
const label = 'flex flex-col gap-1 text-sm font-medium text-text';
const submit =
  'min-h-11 rounded-md bg-brand-green px-4 font-medium text-surface hover:bg-brand-green-deep disabled:opacity-60';

function Panel({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <details className="rounded-lg border border-border bg-surface" data-action={id}>
      <summary className="flex min-h-11 cursor-pointer items-center px-4 font-medium text-brand-purple">
        {title}
      </summary>
      <div className="border-t border-border p-4">{children}</div>
    </details>
  );
}

const value = (form: FormData, key: string) => {
  const v = String(form.get(key) ?? '').trim();
  return v === '' ? undefined : v;
};

/** "1.234,56" or "1234.56" → "1234.56" — the server validates strictly again. */
function amountInput(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const s = raw.replace(/\s/g, '');
  return s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s;
}

export function CustomerActions({
  customerId,
  caseId,
  currency,
  today,
  permissions,
  openInvoices,
  outcomes,
  nextActions,
}: {
  customerId: string;
  caseId?: string;
  currency: string;
  today: string;
  permissions: string[];
  openInvoices: OpenInvoice[];
  outcomes: Record<string, string>;
  nextActions: Record<string, string>;
}) {
  const t = useTranslations('collections');
  const locale = useLocale();
  const { run, problem, notice, busy } = useAction();
  const can = (key: string) => permissions.includes(key);
  const [picked, setPicked] = useState<string[]>([]);

  async function submitForm(
    event: FormEvent<HTMLFormElement>,
    path: string,
    body: (f: FormData) => unknown,
    message: string,
  ) {
    event.preventDefault();
    const form = event.currentTarget;
    if (await run('POST', path, body(new FormData(form)), message)) {
      form.reset();
      setPicked([]);
    }
  }

  return (
    <section aria-label={t('actionsLabel')} className="mt-4 flex flex-col gap-2">
      <FormError problem={problem} />
      <FormSuccess message={notice} />
      {can(PERM.case) && !caseId ? (
        <Panel id="case" title={t('case.new')}>
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) =>
              submitForm(
                e,
                '/api/cases',
                (f) => ({ customerId, invoiceIds: picked, priority: value(f, 'priority') }),
                t('case.created'),
              )
            }
          >
            {openInvoices.length === 0 ? (
              <p className="text-sm text-text-muted">{t('case.noInvoices')}</p>
            ) : null}
            <fieldset className="flex flex-col gap-1">
              <legend className="text-sm font-medium text-text">{t('case.invoices')}</legend>
              {openInvoices.map((i) => (
                <label key={i.id} className="flex min-h-11 items-center gap-2 text-sm text-text">
                  <input
                    type="checkbox"
                    className="size-5"
                    checked={picked.includes(i.id)}
                    onChange={(e) =>
                      setPicked((p) =>
                        e.target.checked ? [...p, i.id] : p.filter((x) => x !== i.id),
                      )
                    }
                    data-case-invoice
                  />
                  {i.number} · {formatAmount(i.amountOpen, i.currency, locale)} ·{' '}
                  {t('due', { date: i.dueDate })}
                </label>
              ))}
            </fieldset>
            <label className={label}>
              {t('case.priority')}
              <select name="priority" className={field} defaultValue="normal">
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {t(`priority.${p}`)}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" className={submit} disabled={busy || picked.length === 0}>
              {t('case.create')}
            </button>
          </form>
        </Panel>
      ) : null}

      {can(PERM.promise) ? (
        <Panel id="promise" title={t('promise.new')}>
          <form
            className="grid gap-3 md:grid-cols-3"
            onSubmit={(e) =>
              submitForm(
                e,
                '/api/promises',
                (f) => ({
                  customerId,
                  caseId,
                  amount: amountInput(value(f, 'amount')),
                  currency,
                  promisedOn: value(f, 'promisedOn'),
                }),
                t('promise.created'),
              )
            }
          >
            <label className={label}>
              {t('promise.amount', { currency })}
              <input
                name="amount"
                inputMode="decimal"
                required
                autoComplete="off"
                className={field}
              />
            </label>
            <label className={label}>
              {t('promise.date')}
              <input name="promisedOn" type="date" min={today} required className={field} />
            </label>
            <button type="submit" className={`${submit} self-end`} disabled={busy}>
              {t('promise.create')}
            </button>
          </form>
        </Panel>
      ) : null}

      {can(PERM.activity) ? (
        <Panel id="activity" title={t('activity.new')}>
          <form
            className="grid gap-3 md:grid-cols-2"
            onSubmit={(e) =>
              submitForm(
                e,
                '/api/activities',
                (f) => ({
                  customerId,
                  caseId,
                  kind: value(f, 'kind'),
                  outcomeCode: value(f, 'outcome'),
                  nextActionCode: value(f, 'nextAction'),
                  nextActionOn: value(f, 'nextActionOn'),
                  note: value(f, 'note'),
                }),
                t('activity.created'),
              )
            }
          >
            <label className={label}>
              {t('activity.kind')}
              <select name="kind" className={field} defaultValue="call">
                {ACTIVITY_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {t(`activity.kinds.${k}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className={label}>
              {t('activity.outcome')}
              <select name="outcome" className={field} defaultValue="">
                <option value="">{t('none')}</option>
                {Object.entries(outcomes).map(([code, text]) => (
                  <option key={code} value={code}>
                    {text}
                  </option>
                ))}
              </select>
            </label>
            <label className={label}>
              {t('activity.nextAction')}
              <select name="nextAction" className={field} defaultValue="">
                <option value="">{t('none')}</option>
                {Object.entries(nextActions).map(([code, text]) => (
                  <option key={code} value={code}>
                    {text}
                  </option>
                ))}
              </select>
            </label>
            <label className={label}>
              {t('activity.nextActionOn')}
              <input name="nextActionOn" type="date" min={today} className={field} />
            </label>
            <label className={`${label} md:col-span-2`}>
              {t('activity.note')}
              <textarea
                name="note"
                maxLength={4000}
                className="min-h-20 rounded-md border border-border bg-surface p-2 text-text"
              />
            </label>
            <button type="submit" className={submit} disabled={busy}>
              {t('activity.create')}
            </button>
          </form>
        </Panel>
      ) : null}

      {can(PERM.payment) && !caseId ? (
        <Panel id="payment" title={t('payment.new')}>
          <form
            className="grid gap-3 md:grid-cols-2"
            onSubmit={(e) =>
              submitForm(
                e,
                '/api/payments',
                (f) => ({
                  customerId,
                  amount: amountInput(value(f, 'amount')),
                  currency,
                  paidOn: value(f, 'paidOn'),
                  reference: value(f, 'reference'),
                  invoiceId: value(f, 'invoiceId'),
                }),
                t('payment.created'),
              )
            }
          >
            <label className={label}>
              {t('payment.amount', { currency })}
              <input
                name="amount"
                inputMode="decimal"
                required
                autoComplete="off"
                className={field}
              />
            </label>
            <label className={label}>
              {t('payment.date')}
              <input
                name="paidOn"
                type="date"
                max={today}
                defaultValue={today}
                required
                className={field}
              />
            </label>
            <label className={label}>
              {t('payment.invoice')}
              <select name="invoiceId" className={field} defaultValue="">
                <option value="">{t('payment.fifo')}</option>
                {openInvoices
                  .filter((i) => i.currency === currency)
                  .map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.number} · {formatAmount(i.amountOpen, i.currency, locale)}
                    </option>
                  ))}
              </select>
            </label>
            <label className={label}>
              {t('payment.reference')}
              <input name="reference" maxLength={200} autoComplete="off" className={field} />
            </label>
            <button type="submit" className={submit} disabled={busy}>
              {t('payment.create')}
            </button>
          </form>
        </Panel>
      ) : null}
    </section>
  );
}

/** Edit date / cancel of a pending promise (promise.update). */
export function PromiseActions({ promiseId, today }: { promiseId: string; today: string }) {
  const t = useTranslations('collections.promise');
  const { run, problem, busy } = useAction();
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="mt-2 flex flex-wrap items-end gap-2" data-promise-actions>
      <FormError problem={problem} />
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const date = String(new FormData(e.currentTarget).get('promisedOn') ?? '');
          void run('PUT', `/api/promises/${promiseId}`, { promisedOn: date }, t('updated'));
        }}
      >
        <label className="flex flex-col gap-1 text-xs text-text-muted">
          {t('newDate')}
          <input name="promisedOn" type="date" min={today} required className={field} />
        </label>
        <button
          type="submit"
          disabled={busy}
          className="min-h-11 rounded-md border border-brand-purple px-3 text-sm text-brand-purple"
        >
          {t('reschedule')}
        </button>
      </form>
      {confirm ? (
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void run('PUT', `/api/promises/${promiseId}`, { cancel: true }, t('cancelled'))
          }
          className="min-h-11 rounded-md border border-status-danger-fg px-3 text-sm text-status-danger-fg"
        >
          {t('confirmCancel')}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setConfirm(true)}
          className="min-h-11 rounded-md border border-border px-3 text-sm text-text"
        >
          {t('cancel')}
        </button>
      )}
    </div>
  );
}
