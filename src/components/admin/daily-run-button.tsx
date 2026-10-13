'use client';

import { useTranslations } from 'next-intl';
import { FormError, FormSuccess } from '@/components/auth/form-message';
import { useAction } from './use-action';

// Admin → System status (task 3.3): run today's daily job now (idempotent, audited).
export function DailyRunButton() {
  const t = useTranslations('admin.status');
  const { run, problem, notice, busy } = useAction();
  return (
    <div className="flex flex-col gap-2" data-daily-run>
      <FormError problem={problem} />
      <FormSuccess message={notice} />
      <button
        type="button"
        disabled={busy}
        onClick={() => void run('POST', '/api/settings/daily-run', {}, t('dailyRunQueued'))}
        className="min-h-11 self-start rounded-md border border-brand-purple px-3 text-sm font-medium text-brand-purple hover:bg-brand-purple-soft disabled:opacity-60"
      >
        {t('dailyRun')}
      </button>
      <p className="text-xs text-text-muted">{t('dailyRunHint')}</p>
    </div>
  );
}
