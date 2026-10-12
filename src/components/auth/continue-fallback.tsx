'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';

export const CONTINUE_FALLBACK_MS = 2_000;

/**
 * Navigates after a successful auth step and, if the page is still here 2 s later (the browser
 * did not navigate — seen on the preview with a browser extension), offers a "Continue" link so
 * nobody stays stuck on a completed step.
 */
export function useNavigateWithFallback(): {
  go: (href: string) => void;
  fallbackHref: string | null;
} {
  const [fallbackHref, setFallbackHref] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const go = useCallback((href: string) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setFallbackHref(href), CONTINUE_FALLBACK_MS);
    window.location.assign(href);
  }, []);

  return { go, fallbackHref };
}

export function ContinueFallback({ href }: { href: string | null }) {
  const t = useTranslations('auth.common');
  if (!href) return null;
  return (
    <div role="status" data-testid="continue-fallback" className="flex flex-col gap-2">
      <p className="text-sm text-text-muted">{t('continueHint')}</p>
      <Link
        href={href}
        className="inline-flex min-h-11 items-center justify-center rounded-md bg-brand-green px-4 font-medium text-surface hover:bg-brand-green-deep"
      >
        {t('continue')}
      </Link>
    </div>
  );
}
