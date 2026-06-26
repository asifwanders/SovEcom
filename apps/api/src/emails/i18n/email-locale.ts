/**
 * server-side email locale resolution.
 *
 * Transactional emails ship in EN + FR. The locale is resolved at SEND time from the
 * customer's stored `customers.locale` (nullable). Resolution is null-safe and total:
 * a missing OR unrecognized value falls back to {@link DEFAULT_LOCALE} ('en'),
 * so the checkout/order email path is NEVER blocked by locale and can never throw here.
 */

/** Locales with full email catalogs. EN is the default. */
export const EMAIL_LOCALES = ['en', 'fr'] as const;

export type EmailLocale = (typeof EMAIL_LOCALES)[number];

/** Fallback locale when the customer's stored locale is null/unknown. */
export const DEFAULT_LOCALE: EmailLocale = 'en';

/**
 * Resolve a stored value (e.g. `customers.locale`) to a supported {@link EmailLocale}.
 * Total + null-safe: anything not in {@link EMAIL_LOCALES} → {@link DEFAULT_LOCALE}.
 * Case-insensitive ('FR' → 'fr'); never throws.
 */
export function resolveEmailLocale(stored: string | null | undefined): EmailLocale {
  if (typeof stored !== 'string') return DEFAULT_LOCALE;
  const lower = stored.trim().toLowerCase();
  return (EMAIL_LOCALES as readonly string[]).includes(lower)
    ? (lower as EmailLocale)
    : DEFAULT_LOCALE;
}
