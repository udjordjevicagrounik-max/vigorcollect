'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { FormError, FormSuccess } from '@/components/auth/form-message';
import { useAction } from '@/components/admin/use-action';
import { formatAmount } from '@/lib/format-amount';

// Disputes on Customer 360 (5.1): open a dispute over chosen invoices, move it through its
// statuses (resolution note when closing), and set the customer's payment behaviour. The server
// checks permission + scope again; the controls only follow the member's permissions.

type OpenInvoice = { id: string; number: string; amountOpen: string; currency: string };
type Option = { code: string; label: string };
export type DisputeItem = {
  id: string;
  reasonCode: string;
  status: string;
  ownerName: string | null;
  openedAt: string;
  expectedBy: string | null;
  invoiceNumbers: string[];
  hasResolutionNote: boolean;
};

const field = 'min-h-11 rounded-md border border-border bg-surface px-3 text-text';
const label = 'flex flex-col gap-1 text-sm font-medium text-text';
const submit =
  'min-h-11 rounded-md bg-brand-green px-4 font-medium text-surface hover:bg-brand-green-deep disabled:opacity-60';
const secondary =
  'min-h-11 rounded-md border border-border bg-surface px-3 text-sm font-medium text-brand-purple disabled:opacity-60';
const NEXT: Record<string, string[]> = {
  open: ['in_review', 'resolved_accepted', 'resolved_rejected', 'withdrawn'],
  in_review: ['resolved_accepted', 'resolved_rejected', 'withdrawn'],
};
const CLOSING = new Set(['resolved_accepted', 'resolved_rejected', 'withdrawn']);

export function PaymentBehaviour({
  customerId,
  current,
  options,
  canEdit,
}: {
  customerId: string;
  current: string | null;
  options: Option[];
  canEdit: boolean;
}) {
  const t = useTranslations('disputes');
  const { run, problem, busy } = useAction();
  const currentLabel = options.find((o) => o.code === current)?.label ?? t('behaviourNone');
  if (!canEdit) {
    return (
      <p className="text-sm text-text-muted" data-payment-behaviour={current ?? ''}>
        {t('behaviour')}: {currentLabel}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <label className="flex items-center gap-2 text-sm text-text">
        {t('behaviour')}
        <select
          className={field}
          value={current ?? ''}
          disabled={busy}
          data-payment-behaviour={current ?? ''}
          onChange={(e) =>
            void run(
              'PUT',
              `/api/customers/${customerId}/payment-behaviour`,
              { code: e.target.value === '' ? null : e.target.value },
              t('behaviourSaved'),
            )
          }
        >
          <option value="">{t('behaviourNone')}</option>
          {options.map((o) => (
            <option key={o.code} value={o.code}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <FormError problem={problem} />
    </div>
  );
}

export function DisputePanel({
  customerId,
  disputes,
  openInvoices,
  reasons,
  permissions,
}: {
  customerId: string;
  disputes: DisputeItem[];
  openInvoices: OpenInvoice[];
  reasons: Option[];
  permissions: string[];
}) {
  const t = useTranslations('disputes');
  const locale = useLocale();
  const { run, problem, notice, busy } = useAction();
  const [closing, setClosing] = useState<{ id: string; status: string } | null>(null);
  const canUpdate = permissions.includes('dispute.update');
  const canCreate = permissions.includes('dispute.create');
  const reasonLabel = (code: string) => reasons.find((r) => r.code === code)?.label ?? code;

  async function open(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const ok = await run(
      'POST',
      '/api/disputes',
      {
        customerId,
        invoiceIds: form.getAll('invoiceIds').map(String),
        reasonCode: String(form.get('reasonCode') ?? ''),
        ...(form.get('expectedBy') ? { expectedBy: String(form.get('expectedBy')) } : {}),
      },
      t('opened'),
    );
    if (ok) event.currentTarget?.reset();
  }

  async function close(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!closing) return;
    const note = String(new FormData(event.currentTarget).get('note') ?? '').trim();
    const ok = await run(
      'PUT',
      `/api/disputes/${closing.id}`,
      { status: closing.status, ...(note ? { resolutionNote: note } : {}) },
      t('updated'),
    );
    if (ok) setClosing(null);
  }

  return (
    <div className="flex flex-col gap-4" data-disputes>
      <FormError problem={problem} />
      <FormSuccess message={notice} />
      {disputes.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface p-4">
          <p className="font-semibold text-brand-green">{t('emptyTitle')}</p>
          <p className="mt-1 text-sm text-text-muted">{t('emptyDescription')}</p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {disputes.map((d) => (
            <li
              key={d.id}
              className="rounded-lg border border-border bg-surface p-3 text-sm"
              data-dispute={d.status}
            >
              <p className="font-medium text-text">
                {reasonLabel(d.reasonCode)} · {t(`status.${d.status as 'open'}`)}
              </p>
              <p className="text-text-muted">
                {t('invoices', { list: d.invoiceNumbers.join(', ') })} ·{' '}
                {t('openedOn', {
                  date: new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(
                    new Date(d.openedAt),
                  ),
                })}
                {d.expectedBy ? ` · ${t('expectedBy', { date: d.expectedBy })}` : ''}
                {d.ownerName ? ` · ${d.ownerName}` : ''}
              </p>
              {canUpdate && NEXT[d.status] ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  {(NEXT[d.status] ?? []).map((s) => (
                    <button
                      key={s}
                      type="button"
                      className={secondary}
                      disabled={busy}
                      data-dispute-to={s}
                      onClick={() =>
                        CLOSING.has(s)
                          ? setClosing({ id: d.id, status: s })
                          : void run('PUT', `/api/disputes/${d.id}`, { status: s }, t('updated'))
                      }
                    >
                      {t(`to.${s as 'in_review'}`)}
                    </button>
                  ))}
                </div>
              ) : null}
              {closing?.id === d.id ? (
                <form onSubmit={close} className="mt-2 flex flex-col gap-2">
                  <label className={label}>
                    {t('resolutionNote')}
                    <textarea name="note" maxLength={4000} rows={3} className={`${field} py-2`} />
                  </label>
                  <div className="flex gap-2">
                    <button type="submit" className={submit} disabled={busy}>
                      {t(`to.${closing.status as 'withdrawn'}`)}
                    </button>
                    <button type="button" className={secondary} onClick={() => setClosing(null)}>
                      {t('cancel')}
                    </button>
                  </div>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {canCreate && openInvoices.length > 0 ? (
        <details className="rounded-lg border border-border bg-surface" data-action="dispute">
          <summary className="flex min-h-11 cursor-pointer items-center px-4 font-medium text-brand-purple">
            {t('openTitle')}
          </summary>
          <form onSubmit={open} className="flex flex-col gap-3 border-t border-border p-4">
            <fieldset className="flex flex-col gap-1">
              <legend className="text-sm font-medium text-text">{t('chooseInvoices')}</legend>
              {openInvoices.map((i) => (
                <label key={i.id} className="flex min-h-11 items-center gap-2 text-sm text-text">
                  <input type="checkbox" name="invoiceIds" value={i.id} /> {i.number} ·{' '}
                  {formatAmount(i.amountOpen, i.currency, locale)}
                </label>
              ))}
            </fieldset>
            <label className={label}>
              {t('reason')}
              <select name="reasonCode" required className={field}>
                {reasons.map((r) => (
                  <option key={r.code} value={r.code}>
                    {r.label}
                  </option>
                ))}
              </select>
            </label>
            <label className={label}>
              {t('expectedByLabel')}
              <input type="date" name="expectedBy" className={field} />
            </label>
            <button type="submit" className={submit} disabled={busy}>
              {t('open')}
            </button>
          </form>
        </details>
      ) : null}
    </div>
  );
}
