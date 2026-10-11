// sr-Latn is the translation source; en is the default for new tenants (rule 25).
export const LOCALES = ['sr-Latn', 'en'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';
export const LOCALE_COOKIE = 'locale';

export function isLocale(value: string | undefined | null): value is Locale {
  return LOCALES.some((locale) => locale === value);
}

// Minimal Accept-Language match: exact tag first, then any `sr*` → sr-Latn, `en*` → en.
export function matchAcceptLanguage(header: string | null): Locale | null {
  if (!header) return null;
  const tags = header
    .split(',')
    .map((part) => part.split(';')[0]?.trim().toLowerCase())
    .filter((tag): tag is string => Boolean(tag));
  for (const tag of tags) {
    if (tag === 'sr-latn' || tag.startsWith('sr')) return 'sr-Latn';
    if (tag.startsWith('en')) return 'en';
  }
  return null;
}
