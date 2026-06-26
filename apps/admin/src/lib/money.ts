/**
 * Format an integer amount in a currency's MINOR units as a display string.
 *
 * Minor units per major unit are currency-specific — 2 for most (EUR/USD), 0 for
 * zero-decimal currencies (JPY, KRW, CLP, VND), 3 for others (KWD, BHD, OMR). We
 * derive the exponent from Intl so every ISO-4217 currency renders correctly and
 * NEVER assume /100.
 * Example: 1234, 'EUR' → '€12.34'  ·  1234, 'JPY' → '¥1,234'  ·  1234, 'KWD' → 'KWD 1.234'
 * Falls back to a plain string if Intl is unavailable or the currency code is malformed.
 */
export function formatMoney(amountMinor: number, currency: string): string {
  const code = currency.toUpperCase();
  try {
    const fmt = new Intl.NumberFormat(undefined, { style: 'currency', currency: code });
    const fractionDigits = fmt.resolvedOptions().maximumFractionDigits ?? 2;
    return fmt.format(amountMinor / 10 ** fractionDigits);
  } catch {
    // Unknown/malformed code → assume the common 2-decimal case.
    return `${(amountMinor / 100).toFixed(2)} ${code}`;
  }
}

// parseMoney was removed: it mis-parsed EU-format numbers (e.g. "1.234,56")
// because it only stripped non-digit/dot/dash chars. Price fields are integer-cents
// inputs so no parsing helper is needed at this layer.
