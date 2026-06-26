/**
 * Type-safe next-intl messages. Augments next-intl's `Messages` with the EN
 * catalog shape so `useTranslations`/`getTranslations` keys are checked at compile time — a typo or
 * missing namespace fails `typecheck`, complementing the runtime key-parity test in messages.spec.
 */
import type en from '../messages/en.json';
import type { routing } from './i18n/routing';

declare module 'next-intl' {
  interface AppConfig {
    Locale: (typeof routing.locales)[number];
    Messages: typeof en;
  }
}
