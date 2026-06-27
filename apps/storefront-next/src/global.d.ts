/**
 * Global type augmentations for the storefront.
 *
 * - next-intl: type-safe message keys (a typo fails typecheck).
 * - Window.__SOVECOM__: runtime config injected by the locale layout server component.
 */
import type en from '../messages/en.json';
import type { routing } from './i18n/routing';

/** Runtime config injected by the locale layout via a server-rendered <script> tag. */
interface SovEcomRuntimeConfig {
  /** Public API base URL resolved server-side from process.env.API_BASE_URL. */
  apiBaseUrl?: string;
}

// This file has imports (making it a module), so Window must be augmented inside
// `declare global {}` rather than at the top level.
declare global {
  interface Window {
    __SOVECOM__?: SovEcomRuntimeConfig;
  }
}

declare module 'next-intl' {
  interface AppConfig {
    Locale: (typeof routing.locales)[number];
    Messages: typeof en;
  }
}
