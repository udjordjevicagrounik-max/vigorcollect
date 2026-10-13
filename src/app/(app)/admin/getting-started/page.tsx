import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { ForbiddenState } from '@/components/admin/forbidden-state';
import { PageHeader } from '@/components/admin/page-header';
import { Screen } from '@/components/shell/screen';
import { PermissionDeniedError } from '@/server/auth/permissions';
import { withTenantPage } from '@/server/auth/with-tenant';
import { onboardingState } from '@/server/onboarding/service';

export const dynamic = 'force-dynamic';

// Admin → Getting started (5.4), mobile-full: twelve steps detected from data, each with a link.
export default async function GettingStartedPage() {
  let state;
  try {
    state = await withTenantPage((ctx) => onboardingState(ctx));
  } catch (error) {
    if (error instanceof PermissionDeniedError) return <ForbiddenState />;
    throw error;
  }
  const t = await getTranslations('onboarding');
  const percent = Math.round((state.done * 100) / state.total);
  return (
    <Screen mobileClass="mobile-full">
      <PageHeader title={t('title')} description={t('description')} />
      <section className="rounded-lg border border-border bg-surface p-4" data-onboarding={percent}>
        <p className="font-medium text-text">
          {t('progress', { done: state.done, total: state.total })}
        </p>
        <div className="mt-2 h-2 rounded bg-brand-purple-soft" aria-hidden="true">
          <span className="block h-2 rounded bg-brand-green" style={{ width: `${percent}%` }} />
        </div>
        {state.complete ? <p className="mt-3 text-sm text-text-muted">{t('complete')}</p> : null}
      </section>
      <ol className="mt-4 flex flex-col gap-2">
        {state.steps.map((s, i) => (
          <li key={s.key} data-step={s.key} data-done={s.done ? '1' : '0'}>
            <Link
              href={s.href}
              className="flex min-h-11 items-start gap-3 rounded-lg border border-border bg-surface p-3 hover:bg-brand-purple-soft"
            >
              <span
                aria-hidden="true"
                className={`mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${s.done ? 'bg-status-success-bg text-status-success-fg' : 'bg-brand-purple-soft text-brand-purple'}`}
              >
                {i + 1}
              </span>
              <span className="flex flex-col">
                <span className="font-medium text-text">
                  {t(`steps.${s.key}.title`)}
                  <span className="sr-only"> — {s.done ? t('done') : t('todo')}</span>
                </span>
                <span className="text-sm text-text-muted">{t(`steps.${s.key}.hint`)}</span>
              </span>
            </Link>
          </li>
        ))}
      </ol>
    </Screen>
  );
}
