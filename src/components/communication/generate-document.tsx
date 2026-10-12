'use client';

import { useTranslations } from 'next-intl';
import { FormError, FormSuccess } from '@/components/auth/form-message';
import { useAction } from '@/components/admin/use-action';

const KINDS = ['dunning_letter', 'statement'] as const;

// Generate a dunning letter or a statement of open items from the tenant's templates.
export function GenerateDocument({ customerId }: { customerId: string }) {
  const t = useTranslations('documents');
  const { run, problem, notice, busy } = useAction();
  return (
    <div className="flex flex-col gap-2" data-generate-documents>
      <FormError problem={problem} />
      <FormSuccess message={notice} />
      <div className="flex flex-wrap gap-2">
        {KINDS.map((kind) => (
          <button
            key={kind}
            type="button"
            disabled={busy}
            data-generate={kind}
            onClick={() =>
              void run('POST', `/api/customers/${customerId}/documents`, { kind }, t('generated'))
            }
            className="min-h-11 rounded-md border border-brand-purple px-3 text-sm font-medium text-brand-purple hover:bg-brand-purple-soft disabled:opacity-60"
          >
            {t(`generate.${kind}`)}
          </button>
        ))}
      </div>
    </div>
  );
}
