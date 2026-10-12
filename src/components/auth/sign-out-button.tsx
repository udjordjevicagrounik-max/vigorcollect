'use client';

import { useTranslations } from 'next-intl';
import { postJSON } from '@/lib/post-json';

export function SignOutButton({ className }: { className?: string }) {
  const t = useTranslations('auth.common');
  return (
    <button
      type="button"
      onClick={async () => {
        await postJSON('/api/auth/sign-out', {});
        window.location.assign('/login');
      }}
      className={
        className ?? 'min-h-11 rounded-md px-3 text-left text-text hover:bg-brand-purple-soft'
      }
    >
      {t('signOut')}
    </button>
  );
}
