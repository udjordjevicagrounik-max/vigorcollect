'use client';

import { useTranslations } from 'next-intl';
import { type FormEvent } from 'react';
import { FormError, FormSuccess } from '@/components/auth/form-message';
import { useAction } from '@/components/admin/use-action';

type Prefs = {
  dailyDigest: boolean;
  weeklyDigest: boolean;
  inAppAttention: boolean;
  inAppMail: boolean;
};
const KEYS = ['dailyDigest', 'weeklyDigest', 'inAppAttention', 'inAppMail'] as const;

// Notification preferences (5.2): which digests and which in-app lists the member gets.
export function NotificationPreferences({ current }: { current: Prefs }) {
  const t = useTranslations('notifications');
  const { run, problem, notice, busy } = useAction();
  const now = useAction();

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    await run(
      'PUT',
      '/api/notification-preferences',
      Object.fromEntries(KEYS.map((k) => [k, f.get(k) === 'on'])),
      t('saved'),
    );
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-2" data-notification-preferences>
      {KEYS.map((k) => (
        <label key={k} className="flex min-h-11 items-center gap-3 text-sm text-text">
          <input type="checkbox" name={k} defaultChecked={current[k]} className="size-5" />
          {t(k)}
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
      <FormSuccess message={notice} />
      <div className="mt-4 border-t border-border pt-4">
        <button
          type="button"
          disabled={now.busy}
          data-digest-now
          className="min-h-11 rounded-md border border-border bg-surface px-3 text-sm font-medium text-brand-purple disabled:opacity-60"
          onClick={() =>
            void now.run('POST', '/api/notification-preferences/digest-now', {}, t('digestSent'))
          }
        >
          {t('digestNow')}
        </button>
        <FormError problem={now.problem} />
        <FormSuccess message={now.notice} />
      </div>
    </form>
  );
}
