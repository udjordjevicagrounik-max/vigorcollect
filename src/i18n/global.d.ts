import type messages from '../../messages/sr-Latn.json';
import type { Locale } from './config';

// sr-Latn is the source of truth for message keys; en must mirror it (checked in tests).
declare module 'next-intl' {
  interface AppConfig {
    Locale: Locale;
    Messages: typeof messages;
  }
}
