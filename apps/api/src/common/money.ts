/**
 * Minor-units-aware money formatting. Shared by the invoice PDF (2.8b) and the
 * email templates (2.12) so both render every ISO-4217 currency correctly.
 *
 * Minor units per major unit are currency-specific: 2 for most (EUR/USD), 0 for zero-decimal
 * currencies (JPY/KRW/CLP/VND), 3 for KWD/BHD/OMR. The exponent is derived from `Intl` so we
 * NEVER assume `/100` (the old bug: 1000 JPY → ¥10). Mirrors apps/admin/src/lib/money.ts;
 * falls back to the common 2-decimal case if Intl is unavailable or the code is malformed.
 *
 * Example: 1234 EUR → "12.34 EUR"  ·  1000 JPY → "1000 JPY"  ·  1234 KWD → "1.234 KWD".
 */
export function formatMoney(amount: number, currency: string): string {
  const code = currency.toUpperCase();
  const sign = amount < 0 ? '-' : '';
  const abs = Math.abs(amount);
  let fractionDigits: number;
  try {
    fractionDigits =
      new Intl.NumberFormat(undefined, { style: 'currency', currency: code }).resolvedOptions()
        .maximumFractionDigits ?? 2;
  } catch {
    fractionDigits = 2;
  }
  if (fractionDigits === 0) {
    return `${sign}${abs.toString()} ${code}`;
  }
  const divisor = 10 ** fractionDigits;
  const major = Math.floor(abs / divisor);
  const minor = (abs % divisor).toString().padStart(fractionDigits, '0');
  return `${sign}${major}.${minor} ${code}`;
}
