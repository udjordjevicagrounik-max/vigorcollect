'use client';

import { useTranslations } from 'next-intl';
import { FormError, FormSuccess } from '@/components/auth/form-message';
import { useAction } from '@/components/admin/use-action';

// "Submit for approval" on a rule proposal (task 3.3; rules 11 and 19): the rule only
// recommended — a person sends it to a checker (another person decides).
export function ProposalSubmit({ decisionId }: { decisionId: string }) {
  const t = useTranslations('attention');
  const { run, problem, notice, busy } = useAction();
  return (
    <span className="flex flex-col gap-1">
      <button
        type="button"
        disabled={busy || notice !== null}
        onClick={() => void run('POST', `/api/decisions/${decisionId}/submit`, {}, t('submitted'))}
        className="min-h-11 rounded-md border border-brand-purple px-3 text-sm font-medium text-brand-purple hover:bg-brand-purple-soft disabled:opacity-60"
        data-proposal-submit={decisionId}
      >
        {t('submitForApproval')}
      </button>
      <FormError problem={problem} />
      <FormSuccess message={notice} />
    </span>
  );
}
