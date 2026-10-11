'use client';

import Link from 'next/link';
import { useSyncExternalStore } from 'react';
import { useTranslations } from 'next-intl';
import { Screen } from '@/components/shell/screen';

// The request id is rendered into <body data-request-id> by the root layout.
const subscribeNoop = () => () => {};
const readRequestId = () => document.body.dataset.requestId ?? '';

// Rule 29: human text + action + X-Request-Id for support. Never a stack trace.
export default function ErrorPage({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations('error');
  const requestId = useSyncExternalStore(subscribeNoop, readRequestId, () => '');

  return (
    <Screen mobileClass="mobile-full">
      <section role="alert" className="rounded-lg border border-border bg-surface p-8">
        <h1 className="text-xl font-semibold text-status-danger-fg">{t('title')}</h1>
        <p className="mt-3 text-text-muted">{t('description')}</p>
        {requestId ? (
          <p className="mt-3 font-mono text-sm text-text-muted">{t('requestId', { requestId })}</p>
        ) : null}
        <div className="mt-6 flex flex-wrap gap-3">
          <button
            type="button"
            onClick={reset}
            className="min-h-11 rounded-md bg-brand-green px-4 font-medium text-surface hover:bg-brand-green-deep"
          >
            {t('retry')}
          </button>
          <Link
            href="/"
            className="inline-flex min-h-11 items-center rounded-md border border-brand-purple px-4 font-medium text-brand-purple"
          >
            {t('home')}
          </Link>
        </div>
      </section>
    </Screen>
  );
}
