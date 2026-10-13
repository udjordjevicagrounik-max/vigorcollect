'use client';

import { useTranslations } from 'next-intl';
import { useAction } from '@/components/admin/use-action';

// Inline actions of an attention item: mark a notification read, close a task.
export function AttentionAction({ kind, id }: { kind: 'notification' | 'task_due'; id: string }) {
  const t = useTranslations('attention');
  const { run, busy } = useAction();
  const done =
    kind === 'notification'
      ? () => run('PUT', `/api/notifications/${id}`, { read: true }, t('doneNotice'))
      : () => run('PUT', `/api/tasks/${id}`, { status: 'done' }, t('doneNotice'));
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => void done()}
      className="min-h-11 rounded-md border border-border px-3 text-sm text-text hover:bg-brand-purple-soft disabled:opacity-60"
      data-attention-action={kind}
    >
      {kind === 'notification' ? t('markRead') : t('taskDone')}
    </button>
  );
}
