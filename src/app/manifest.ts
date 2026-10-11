import type { MetadataRoute } from 'next';
import { getProductConfig } from '@/config/product';
import { themeColors } from '@/styles/theme-colors';

export const dynamic = 'force-dynamic';

// PWA manifest. No service worker yet; when added, nothing financial is cached (rule 16).
export default function manifest(): MetadataRoute.Manifest {
  const { productName } = getProductConfig();
  return {
    name: productName,
    short_name: productName,
    start_url: '/',
    display: 'standalone',
    background_color: themeColors.background,
    theme_color: themeColors.brandGreen,
    icons: [],
  };
}
