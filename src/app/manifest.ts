import type { MetadataRoute } from 'next';
import { getProductConfig } from '@/config/product';
import { themeColors } from '@/styles/theme-colors';

export const dynamic = 'force-dynamic';

// PWA manifest (installable: name, start_url, standalone, 192 + 512 icons — scripts/generate-icons.ts).
// No service worker yet; when added, nothing financial is cached (rule 16).
export default function manifest(): MetadataRoute.Manifest {
  const { productName } = getProductConfig();
  return {
    name: productName,
    short_name: productName,
    start_url: '/',
    display: 'standalone',
    background_color: themeColors.background,
    theme_color: themeColors.brandGreen,
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
