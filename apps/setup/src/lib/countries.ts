/**
 * Country + currency reference data for the Tax step.
 *
 * A *reasonable* — deliberately not exhaustive — list: the EU-27 (the wizard's primary
 * audience) plus the common non-EU markets a small merchant is likely to be based in.
 * Kept in this module (not inlined in the component) so the step stays readable.
 *
 * The EU-27 membership set MIRRORS the API's `engine/eu-vat-rules.ts` so the UI can
 * default `tax_mode` and surface the EU guardrail INSTANTLY, without a round-trip. The
 * server remains the source of truth (it re-checks + 422s); this is a fast, friendly
 * first guess. Keep `EU_COUNTRIES` in sync with the API list (a stale copy only affects
 * the optimistic default — the server still enforces the rule).
 */

export interface Country {
  /** ISO 3166-1 alpha-2 (upper-case). */
  code: string;
  name: string;
  /** Flag emoji (rendered as a hint; never the only label — name carries meaning). */
  flag: string;
  /** ISO 4217 default currency for this country (the Tax step's currency pre-fill). */
  currency: string;
}

/**
 * The 27 EU member states — MIRRORS `apps/api/src/taxes/engine/eu-vat-rules.ts`
 * `EU_MEMBER_STATES`. Used client-side to default tax_mode + warn before the API call.
 */
export const EU_COUNTRIES: ReadonlySet<string> = new Set([
  'AT',
  'BE',
  'BG',
  'HR',
  'CY',
  'CZ',
  'DK',
  'EE',
  'FI',
  'FR',
  'DE',
  'GR',
  'HU',
  'IE',
  'IT',
  'LV',
  'LT',
  'LU',
  'MT',
  'NL',
  'PL',
  'PT',
  'RO',
  'SK',
  'SI',
  'ES',
  'SE',
]);

/** True if `code` (ISO α-2, any case) is an EU-27 member state. Mirrors the API. */
export function isEuCountry(code: string | null | undefined): boolean {
  return code != null && EU_COUNTRIES.has(code.toUpperCase());
}

/**
 * The selectable countries. EU-27 first (alphabetical by name), then common non-EU
 * markets. Each carries a default currency so picking a country pre-fills it.
 */
export const COUNTRIES: readonly Country[] = [
  // ── EU-27 (the wizard's primary audience) ──
  { code: 'AT', name: 'Austria', flag: '🇦🇹', currency: 'EUR' },
  { code: 'BE', name: 'Belgium', flag: '🇧🇪', currency: 'EUR' },
  { code: 'BG', name: 'Bulgaria', flag: '🇧🇬', currency: 'BGN' },
  { code: 'HR', name: 'Croatia', flag: '🇭🇷', currency: 'EUR' },
  { code: 'CY', name: 'Cyprus', flag: '🇨🇾', currency: 'EUR' },
  { code: 'CZ', name: 'Czechia', flag: '🇨🇿', currency: 'CZK' },
  { code: 'DK', name: 'Denmark', flag: '🇩🇰', currency: 'DKK' },
  { code: 'EE', name: 'Estonia', flag: '🇪🇪', currency: 'EUR' },
  { code: 'FI', name: 'Finland', flag: '🇫🇮', currency: 'EUR' },
  { code: 'FR', name: 'France', flag: '🇫🇷', currency: 'EUR' },
  { code: 'DE', name: 'Germany', flag: '🇩🇪', currency: 'EUR' },
  { code: 'GR', name: 'Greece', flag: '🇬🇷', currency: 'EUR' },
  { code: 'HU', name: 'Hungary', flag: '🇭🇺', currency: 'HUF' },
  { code: 'IE', name: 'Ireland', flag: '🇮🇪', currency: 'EUR' },
  { code: 'IT', name: 'Italy', flag: '🇮🇹', currency: 'EUR' },
  { code: 'LV', name: 'Latvia', flag: '🇱🇻', currency: 'EUR' },
  { code: 'LT', name: 'Lithuania', flag: '🇱🇹', currency: 'EUR' },
  { code: 'LU', name: 'Luxembourg', flag: '🇱🇺', currency: 'EUR' },
  { code: 'MT', name: 'Malta', flag: '🇲🇹', currency: 'EUR' },
  { code: 'NL', name: 'Netherlands', flag: '🇳🇱', currency: 'EUR' },
  { code: 'PL', name: 'Poland', flag: '🇵🇱', currency: 'PLN' },
  { code: 'PT', name: 'Portugal', flag: '🇵🇹', currency: 'EUR' },
  { code: 'RO', name: 'Romania', flag: '🇷🇴', currency: 'RON' },
  { code: 'SK', name: 'Slovakia', flag: '🇸🇰', currency: 'EUR' },
  { code: 'SI', name: 'Slovenia', flag: '🇸🇮', currency: 'EUR' },
  { code: 'ES', name: 'Spain', flag: '🇪🇸', currency: 'EUR' },
  { code: 'SE', name: 'Sweden', flag: '🇸🇪', currency: 'SEK' },
  // ── Common non-EU markets ──
  { code: 'GB', name: 'United Kingdom', flag: '🇬🇧', currency: 'GBP' },
  { code: 'CH', name: 'Switzerland', flag: '🇨🇭', currency: 'CHF' },
  { code: 'NO', name: 'Norway', flag: '🇳🇴', currency: 'NOK' },
  { code: 'IS', name: 'Iceland', flag: '🇮🇸', currency: 'ISK' },
  { code: 'US', name: 'United States', flag: '🇺🇸', currency: 'USD' },
  { code: 'CA', name: 'Canada', flag: '🇨🇦', currency: 'CAD' },
  { code: 'AU', name: 'Australia', flag: '🇦🇺', currency: 'AUD' },
  { code: 'NZ', name: 'New Zealand', flag: '🇳🇿', currency: 'NZD' },
  { code: 'JP', name: 'Japan', flag: '🇯🇵', currency: 'JPY' },
];

/** Lookup a country by ISO α-2 code (case-insensitive). */
export function findCountry(code: string | null | undefined): Country | undefined {
  if (!code) return undefined;
  const upper = code.toUpperCase();
  return COUNTRIES.find((c) => c.code === upper);
}

/**
 * The currencies an operator can pick. Major + EU-relevant ISO-4217 codes. EUR leads as
 * the sensible default for the EU-first audience; the rest follow alphabetically by code.
 */
export interface Currency {
  code: string;
  name: string;
}

export const CURRENCIES: readonly Currency[] = [
  { code: 'EUR', name: 'Euro' },
  { code: 'AUD', name: 'Australian Dollar' },
  { code: 'BGN', name: 'Bulgarian Lev' },
  { code: 'CAD', name: 'Canadian Dollar' },
  { code: 'CHF', name: 'Swiss Franc' },
  { code: 'CZK', name: 'Czech Koruna' },
  { code: 'DKK', name: 'Danish Krone' },
  { code: 'GBP', name: 'Pound Sterling' },
  { code: 'HUF', name: 'Hungarian Forint' },
  { code: 'ISK', name: 'Icelandic Króna' },
  { code: 'JPY', name: 'Japanese Yen' },
  { code: 'NOK', name: 'Norwegian Krone' },
  { code: 'NZD', name: 'New Zealand Dollar' },
  { code: 'PLN', name: 'Polish Złoty' },
  { code: 'RON', name: 'Romanian Leu' },
  { code: 'SEK', name: 'Swedish Krona' },
  { code: 'USD', name: 'US Dollar' },
];

/** The currency to pre-fill for a country (its national currency, else EUR). */
export function defaultCurrencyFor(code: string | null | undefined): string {
  return findCountry(code)?.currency ?? 'EUR';
}
