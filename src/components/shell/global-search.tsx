'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { postJSON } from '@/lib/post-json';

// Global search in the shell (5.1): the field is always there; Ctrl+K / Cmd+K focuses it from
// anywhere. The query goes in a POST body (never the URL), debounced; ↑/↓ + Enter open a hit.
// The server applies the member's scope; this only shows what came back (max 20).

type Hit = {
  kind: 'customer' | 'invoice' | 'case' | 'contact';
  id: string;
  customerId: string;
  customerName: string | null;
  detail: string | null;
};

const LIST_ID = 'global-search-results';
const href = (h: Hit) =>
  h.kind === 'case'
    ? `/customers/${h.customerId}?tab=cases`
    : h.kind === 'invoice'
      ? `/customers/${h.customerId}?tab=invoices`
      : `/customers/${h.customerId}`;

export function GlobalSearch() {
  const t = useTranslations('search');
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState('');
  const [result, setResult] = useState<{ query: string; items: Hit[] } | null>(null);
  const [closed, setClosed] = useState(false);
  const [active, setActive] = useState(0);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        input.current?.focus();
        input.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const query = q.trim();
    if (query.length < 2) return;
    let live = true;
    const timer = setTimeout(() => {
      void postJSON('/api/search', { q: query }).then((res) => {
        if (!live) return;
        const body = res.json as { hits?: Hit[] } | null;
        setResult({ query, items: res.status === 200 && body?.hits ? body.hits : [] });
        setActive(0);
        setClosed(false);
      });
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [q]);

  const hits = !closed && q.trim().length >= 2 && result?.query === q.trim() ? result.items : null;

  function go(h: Hit | undefined) {
    if (!h) return;
    setQ('');
    setResult(null);
    router.push(href(h));
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (!hits?.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => (a + 1) % hits.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => (a - 1 + hits.length) % hits.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      go(hits[active]);
    } else if (e.key === 'Escape') {
      setClosed(true);
    }
  }

  return (
    <div className="relative" data-global-search>
      <label className="sr-only" htmlFor="global-search">
        {t('label')}
      </label>
      <input
        ref={input}
        id="global-search"
        type="search"
        role="combobox"
        aria-expanded={hits !== null}
        aria-controls={LIST_ID}
        autoComplete="off"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={t('placeholder')}
        className="min-h-11 w-full rounded-md border border-border bg-surface px-3 text-sm text-text"
      />
      {hits !== null ? (
        <ul
          id={LIST_ID}
          role="listbox"
          className="absolute left-0 right-0 z-20 mt-1 max-h-96 overflow-y-auto rounded-md border border-border bg-surface shadow-lg"
        >
          {hits.length === 0 ? (
            <li className="p-3 text-sm text-text-muted">{t('none')}</li>
          ) : (
            hits.map((h, i) => (
              <li
                key={`${h.kind}:${h.id}`}
                role="option"
                aria-selected={i === active}
                data-search-hit={h.kind}
                className={`flex min-h-11 cursor-pointer flex-col justify-center px-3 py-1 text-sm ${i === active ? 'bg-brand-purple-soft' : ''}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  go(h);
                }}
              >
                <span className="font-medium text-text">
                  {h.customerName ?? t('naturalPerson')}
                </span>
                <span className="text-xs text-text-muted">
                  {t(`kind.${h.kind}`)}
                  {h.detail ? ` · ${h.detail}` : ''}
                </span>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
