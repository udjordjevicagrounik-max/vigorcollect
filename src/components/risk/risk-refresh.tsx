'use client';

import { useTranslations } from 'next-intl';
import { FormError, FormSuccess } from '@/components/auth/form-message';
import { useAction } from '@/components/admin/use-action';

// "Refresh now" (customer.update): the same computation as the daily job, for this customer.
export function RiskRefresh({ customerId }: { customerId: string }) {
  const t = useTranslations('risk');
  const { run, problem, notice, busy } = useAction();
  return (
    <div className="flex flex-col gap-2">
      <FormError problem={problem} />
      <FormSuccess message={notice} />
      <button
        type="button"
        disabled={busy}
        data-risk-refresh
        onClick={() => void run('POST', `/api/customers/${customerId}/risk`, {}, t('refreshed'))}
        className="min-h-11 self-start rounded-md border border-brand-purple px-3 text-sm font-medium text-brand-purple hover:bg-brand-purple-soft disabled:opacity-60"
      >
        {t('refresh')}
      </button>
    </div>
  );
}
