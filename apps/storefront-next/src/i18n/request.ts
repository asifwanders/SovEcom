/**
 * Per-request next-intl config. Resolves the active locale from the `[locale]`
 * route segment and loads its message catalog (`messages/<locale>.json`) for server-side rendering
 * of UI chrome strings. Catalog data localization is out of scope.
 *
 * Robustness: an unknown/absent requested locale falls back to the default (`en`) so a malformed
 * URL renders the default-locale chrome rather than crashing. Catalogs are statically imported so
 * Next can bundle them and prerender/ISR the `[locale]` routes.
 */
import { getRequestConfig } from 'next-intl/server';
import { hasLocale } from 'next-intl';
import { routing } from './routing';
import en from '../../messages/en.json';
import fr from '../../messages/fr.json';

const MESSAGES = { en, fr } as const;

export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale = hasLocale(routing.locales, requested) ? requested : routing.defaultLocale;

  return {
    locale,
    messages: MESSAGES[locale],
  };
});
