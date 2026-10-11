import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { Inter } from 'next/font/google';
import { headers } from 'next/headers';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getTranslations } from 'next-intl/server';
import { AppNav } from '@/components/shell/app-nav';
import { getProductConfig } from '@/config/product';
import { REQUEST_ID_HEADER } from '@/lib/request-id';
import { themeColors } from '@/styles/theme-colors';
import './globals.css';

const inter = Inter({
  subsets: ['latin', 'latin-ext'],
  weight: ['400', '500', '600'],
  variable: '--font-inter',
  display: 'swap',
});

export async function generateMetadata(): Promise<Metadata> {
  const { productName } = getProductConfig();
  const t = await getTranslations('app');
  return { title: productName, description: t('description') };
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: themeColors.brandGreen,
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await getLocale();
  const t = await getTranslations('app');
  const { productName } = getProductConfig();
  // Exposed so the client error boundary can show it to the user for support (rule 29).
  const requestId = (await headers()).get(REQUEST_ID_HEADER) ?? '';

  return (
    <html lang={locale} className={inter.variable}>
      <body data-request-id={requestId} className="min-h-dvh bg-background font-sans text-text">
        <NextIntlClientProvider>
          <a
            href="#main"
            className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:rounded focus:bg-surface focus:p-2"
          >
            {t('skipToContent')}
          </a>
          <header className="border-b-[3px] border-brand-gold bg-brand-green-deep px-4 py-3 text-surface">
            <span className="font-semibold">{productName}</span>
          </header>
          <div className="flex flex-col md:flex-row">
            <aside className="border-b border-border bg-surface p-3 md:min-h-[calc(100dvh-3.25rem)] md:w-60 md:border-b-0 md:border-r">
              <AppNav />
            </aside>
            <main id="main" className="flex-1">
              {children}
            </main>
          </div>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
