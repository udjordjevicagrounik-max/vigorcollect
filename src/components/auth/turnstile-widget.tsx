'use client';

import Script from 'next/script';
import { useEffect, useRef, useState } from 'react';

type TurnstileApi = {
  render(
    el: HTMLElement,
    options: {
      sitekey: string;
      callback: (token: string) => void;
      'expired-callback': () => void;
      'error-callback': () => void;
    },
  ): string;
  reset(id: string): void;
  remove(id: string): void;
};

const TURNSTILE_SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

// Cloudflare Turnstile widget (rule 27). Renders nothing without a site key (dev without keys —
// the server skips verification there). Tokens are single-use: bump `resetSignal` after every
// submit. The script carries the CSP nonce.
export function TurnstileWidget({
  siteKey,
  nonce,
  onToken,
  resetSignal = 0,
}: {
  siteKey: string | null;
  nonce?: string | undefined;
  onToken: (token: string | null) => void;
  resetSignal?: number;
}) {
  const container = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);
  const callback = useRef(onToken);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    callback.current = onToken;
  }, [onToken]);

  useEffect(() => {
    const api = window.turnstile;
    if (!siteKey || !ready || !api || !container.current || widgetId.current) return;
    widgetId.current = api.render(container.current, {
      sitekey: siteKey,
      callback: (token) => callback.current(token),
      'expired-callback': () => callback.current(null),
      'error-callback': () => callback.current(null),
    });
    return () => {
      if (widgetId.current) api.remove(widgetId.current);
      widgetId.current = null;
    };
  }, [siteKey, ready]);

  useEffect(() => {
    if (resetSignal && widgetId.current) window.turnstile?.reset(widgetId.current);
  }, [resetSignal]);

  if (!siteKey) return null;
  return (
    <>
      <Script src={TURNSTILE_SCRIPT} nonce={nonce} onReady={() => setReady(true)} />
      <div ref={container} data-testid="turnstile" className="min-h-16" />
    </>
  );
}
