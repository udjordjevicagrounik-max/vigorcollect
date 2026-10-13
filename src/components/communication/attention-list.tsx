import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import { formatAmount } from '@/lib/format-amount';
import type { AttentionItem } from '@/server/attention/service';
import { AttentionAction } from './attention-actions';

const WHEN = { dateStyle: 'medium' } as const;

function href(i: AttentionItem): string {
  switch (i.kind) {
    case 'approval_pending':
      return '/admin/approvals';
    case 'workflow_failed':
      return `/admin/rules/${i.refId}`;
    case 'import_exception':
      return '/import';
    default:
      if (!i.customerId) return '/';
      return i.caseId
        ? `/customers/${i.customerId}/cases/${i.caseId}`
        : `/customers/${i.customerId}`;
  }
}

// Dashboard "Needs attention" (task 3.2): one list, each item with its next step (rule 29).
export async function AttentionList({ items, locale }: { items: AttentionItem[]; locale: string }) {
  const t = await getTranslations('attention');
  const format = await getFormatter();
  return (
    <section
      aria-labelledby="attention-title"
      className="mt-6 rounded-lg border border-border bg-surface p-4"
      data-attention
    >
      <h2 id="attention-title" className="font-semibold text-text">
        {t('title')}
      </h2>
      <p className="text-xs text-text-muted">{t('description')}</p>
      {items.length === 0 ? (
        <p className="mt-3 text-text-muted">{t('empty')}</p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {items.map((i) => (
            <li
              key={`${i.kind}-${i.refId}`}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-2"
              data-attention-item={i.kind}
            >
              <span className="min-w-0 flex-1 text-sm">
                <span className="font-medium text-text">{t(`kinds.${i.kind}`)}</span>
                {i.customerName ? <span className="text-text"> · {i.customerName}</span> : null}
                <span className="block text-text-muted">
                  {i.amount && i.currency ? `${formatAmount(i.amount, i.currency, locale)} · ` : ''}
                  {i.kind === 'notification' && i.code
                    ? `${t.has(`messages.${i.code as 'rule_attention'}`) ? t(`messages.${i.code as 'rule_attention'}`) : i.code} · `
                    : ''}
                  {i.kind === 'import_exception' && i.code
                    ? `${t('exceptions', { n: i.code })} · `
                    : ''}
                  {i.since ? format.dateTime(new Date(i.since), WHEN) : ''}
                </span>
              </span>
              <span className="flex gap-2">
                <Link
                  href={href(i)}
                  className="inline-flex min-h-11 items-center rounded-md bg-brand-green px-3 text-sm font-medium text-surface"
                >
                  {t(`actions.${i.kind}`)}
                </Link>
                {i.kind === 'notification' || i.kind === 'task_due' ? (
                  <AttentionAction kind={i.kind} id={i.refId} />
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
