/**
 * Safe wrapper around Intl.NumberFormat for prices.
 *
 * Takes an integer amount in the currency's MINOR units. The minor-unit exponent is
 * currency-specific (2 for EUR/USD, 0 for JPY/KRW, 3 for KWD/BHD), derived from Intl
 * so every ISO-4217 currency renders correctly — never assume /100.
 * A malformed currency code from the API must not 500 the SSR page → falls back to a
 * "<amount> <CURRENCY>" string.
 */
export function formatPrice(amountMinor: number, currency: string, locale?: string): string {
  const code = currency.toUpperCase();
  try {
    const fmt = new Intl.NumberFormat(locale ?? undefined, { style: 'currency', currency: code });
    const fractionDigits = fmt.resolvedOptions().maximumFractionDigits ?? 2;
    return fmt.format(amountMinor / 10 ** fractionDigits);
  } catch {
    return `${(amountMinor / 100).toFixed(2)} ${code}`;
  }
}

/**
 * Minor-unit exponent for an ISO-4217 currency (2 for EUR/USD, 0 for JPY, 3 for KWD), derived from
 * `Intl`. A malformed code falls back to 2 (the commonest exponent) so the price filter never throws
 * on bad input from a public URL.
 */
export function currencyFractionDigits(currency: string): number {
  try {
    const fmt = new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: currency.toUpperCase(),
    });
    return fmt.resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

/**
 * Convert an integer MINOR-unit amount to its MAJOR-unit value for editing in a price `<input>`
 * (e.g. 1999 EUR cents → 19.99). Currency-exponent aware via {@link currencyFractionDigits}.
 */
export function minorToMajor(amountMinor: number, currency: string): number {
  return amountMinor / 10 ** currencyFractionDigits(currency);
}

/**
 * Parse a user-typed MAJOR-unit price string into an integer MINOR-unit amount for the search query
 * (e.g. "19.99" EUR → 1999). The query value MUST be an integer (money = integer minor units — never
 * a float in the query). Returns `null` for blank/garbage/negative input so the caller can OMIT the
 * param rather than send `NaN`/`0`. Accepts a comma OR dot decimal separator (FR locale types `,`).
 */
export function majorToMinor(raw: string, currency: string): number | null {
  const trimmed = raw.trim().replace(',', '.');
  if (trimmed === '') return null;
  const major = Number(trimmed);
  if (!Number.isFinite(major) || major < 0) return null;
  return Math.round(major * 10 ** currencyFractionDigits(currency));
}
