'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

type InstallEvent = Event & { prompt(): Promise<void> };

// PWA install offer: shown only when the browser says the app is installable
// (beforeinstallprompt). No service worker caches anything financial (rule 16).
export function InstallPrompt() {
  const t = useTranslations('pwa');
  const [event, setEvent] = useState<InstallEvent | null>(null);

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setEvent(e as InstallEvent);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    return () => window.removeEventListener('beforeinstallprompt', onPrompt);
  }, []);

  if (!event) return null;
  return (
    <button
      type="button"
      onClick={() => {
        void event.prompt().finally(() => setEvent(null));
      }}
      title={t('installHint')}
      className="min-h-11 rounded-md px-3 text-left text-brand-purple hover:bg-brand-purple-soft"
    >
      {t('install')}
    </button>
  );
}
