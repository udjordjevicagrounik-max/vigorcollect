'use client';

import { useTranslations } from 'next-intl';
import { useState, type ChangeEvent } from 'react';
import { FormError, FormSuccess, type FormProblem } from '@/components/auth/form-message';
import { useAction } from '@/components/admin/use-action';
import { apiProblem } from '@/lib/api-problem';
import { postJSON } from '@/lib/post-json';

// Admin → Settings → Libraries (6.4): one click each — apply a policy template (rule drafts),
// the questionnaire's proposal, the generic import template, config pack export / import.

const TEMPLATES = ['friendly', 'standard', 'strict', 'agro_seasonal'] as const;
type Template = (typeof TEMPLATES)[number];
const card = 'rounded-lg border border-border bg-surface p-4';
const button =
  'min-h-11 rounded-md border border-border bg-surface px-3 text-sm font-medium text-brand-purple disabled:opacity-60';
const link = 'inline-flex min-h-11 items-center text-sm font-medium text-brand-purple underline';

export function LibraryAdmin({
  canManage,
  proposal,
}: {
  canManage: boolean;
  proposal: Template | null;
}) {
  const t = useTranslations('library');
  const tErrors = useTranslations('errors');
  const apply = useAction();
  const [problem, setProblem] = useState<FormProblem | null>(null);
  const [imported, setImported] = useState<string | null>(null);

  async function onPack(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    setProblem(null);
    setImported(null);
    if (!file) return;
    let body: unknown;
    try {
      body = JSON.parse(await file.text());
    } catch {
      setProblem({ message: t('pack.invalid') });
      return;
    }
    const res = await postJSON('/api/config-pack', body);
    if (res.status !== 200) {
      setProblem(apiProblem(res, tErrors));
      return;
    }
    const n = res.json as Record<string, number>;
    const total = Object.entries(n)
      .filter(([k]) => k !== 'skipped')
      .reduce((s, [, v]) => s + v, 0);
    setImported(t('pack.imported', { added: total, skipped: n.skipped ?? 0 }));
  }

  return (
    <div className="flex flex-col gap-4">
      <section className={card} data-library-policies>
        <h2 className="font-semibold text-brand-green">{t('policies.title')}</h2>
        <p className="mt-1 text-sm text-text-muted">{t('policies.description')}</p>
        {proposal ? (
          <p
            className="mt-2 rounded-md bg-brand-purple-soft p-2 text-sm text-text"
            data-library-proposal
          >
            {t('policies.proposal', { name: t(`policies.names.${proposal}`) })}
          </p>
        ) : null}
        <ul className="mt-3 grid gap-2 md:grid-cols-2">
          {TEMPLATES.map((x) => (
            <li key={x} className="flex flex-col gap-1 rounded-md border border-border p-3">
              <span className="font-medium text-text">{t(`policies.names.${x}`)}</span>
              <span className="text-sm text-text-muted">{t(`policies.summaries.${x}`)}</span>
              {canManage ? (
                <button
                  type="button"
                  className={`${button} self-start`}
                  disabled={apply.busy}
                  data-apply-template={x}
                  onClick={() =>
                    void apply.run(
                      'POST',
                      '/api/library/policy-templates',
                      { template: x },
                      t('policies.applied'),
                    )
                  }
                >
                  {t('policies.apply')}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
        <FormError problem={apply.problem} />
        <FormSuccess message={apply.notice} />
      </section>

      <section className={card}>
        <h2 className="font-semibold text-brand-green">{t('imports.title')}</h2>
        <p className="mt-1 text-sm text-text-muted">{t('imports.description')}</p>
        <a href="/api/library/import-template" className={link} data-import-template>
          {t('imports.download')}
        </a>
      </section>

      {canManage ? (
        <section className={card} data-config-pack>
          <h2 className="font-semibold text-brand-green">{t('pack.title')}</h2>
          <p className="mt-1 text-sm text-text-muted">{t('pack.description')}</p>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <a href="/api/config-pack" className={link}>
              {t('pack.export')}
            </a>
            <label className={`${button} inline-flex cursor-pointer items-center`}>
              {t('pack.import')}
              <input
                type="file"
                accept="application/json,.json"
                className="sr-only"
                onChange={(e) => void onPack(e)}
              />
            </label>
          </div>
          <FormError problem={problem} />
          <FormSuccess message={imported} />
        </section>
      ) : null}
    </div>
  );
}
