import type { ReactNode } from 'react';

// Sign-in screens (login, MFA, invitation, tenant choice): no navigation, one centered card.
// mobile-full (rule 16): the card fills the width on a 375 px screen.
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main id="main" data-mobile-class="mobile-full" className="px-4 py-8 md:py-16">
      {children}
    </main>
  );
}
