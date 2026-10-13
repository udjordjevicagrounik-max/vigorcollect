'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { safeHref, segments } from '@/lib/untrusted-text';

// Received e-mail text (rule 22): plain text only; a URL stays inert until the reader clicks
// "open" for that one link — then it becomes a real link (new tab, no referrer, no opener).
export function UntrustedText({ text }: { text: string }) {
  const t = useTranslations('communication');
  const [opened, setOpened] = useState<Set<number>>(new Set());
  return (
    <p className="whitespace-pre-wrap break-words text-sm text-text" data-untrusted-text>
      {segments(text).map((s, i) => {
        if (s.kind === 'text') return <span key={i}>{s.value}</span>;
        const href = safeHref(s.value);
        if (opened.has(i) && href)
          return (
            <a
              key={i}
              href={href}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="text-brand-purple underline"
              data-link-open
            >
              {s.value}
            </a>
          );
        return (
          <span key={i} className="text-text-muted" data-link-inert>
            {s.value}{' '}
            {href ? (
              <button
                type="button"
                className="text-xs text-brand-purple underline"
                onClick={() => setOpened((o) => new Set(o).add(i))}
              >
                {t('openLink')}
              </button>
            ) : null}
          </span>
        );
      })}
    </p>
  );
}
