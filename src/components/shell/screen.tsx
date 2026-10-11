import type { ReactNode } from 'react';

// Every screen declares its mobile class (rule 16) and is tested at 375 px.
export type MobileClass = 'mobile-full' | 'mobile-compact' | 'desktop-only';

export function Screen({
  mobileClass,
  children,
}: {
  mobileClass: MobileClass;
  children: ReactNode;
}) {
  return (
    <div data-mobile-class={mobileClass} className="mx-auto w-full max-w-5xl px-4 py-6 md:px-8">
      {children}
    </div>
  );
}
