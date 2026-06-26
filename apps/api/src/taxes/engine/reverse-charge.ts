/**
 * B2B reverse-charge decision.
 *
 * Cross-border EU B2B with a VIES-validated VAT number → the SELLER charges 0% VAT
 * and the BUYER self-accounts ("autoliquidation"); the invoice carries a
 * reverse-charge note. Conditions (ALL required):
 *
 *   1. The cart owner is B2B (`is_b2b`).
 *   2. Their VAT number was positively VIES-validated (`vat_validated`). A B2B
 *      customer with an INVALID/unvalidated number falls back to VAT charged
 *      (tax fails SAFE).
 *   3. The sale is CROSS-BORDER within the EU: destination ≠ origin, BOTH in the EU.
 *
 * B2B SAME-COUNTRY → local VAT (not reverse charge). Any non-EU leg → handled by the
 * resolver's EU-membership gate, not here.
 */
import type { TaxCustomerContext } from './tax-resolver';
import { isEuCountry } from './eu-vat-rules';

export interface ReverseChargeInput {
  customer: TaxCustomerContext | null;
  /** The merchant's EU country of establishment (tenant origin), or null. */
  originCountry: string | null;
  /** The destination country from the cart shipping address, or null. */
  destinationCountry: string | null;
}

/**
 * True when B2B cross-border reverse charge applies (0% VAT, buyer self-accounts).
 * Returns false on any missing leg — the resolver then charges VAT (fails safe).
 */
export function reverseChargeApplies({
  customer,
  originCountry,
  destinationCountry,
}: ReverseChargeInput): boolean {
  if (!customer || !customer.isB2b || !customer.vatValidated) return false;
  if (!originCountry || !destinationCountry) return false;

  const origin = originCountry.toUpperCase();
  const dest = destinationCountry.toUpperCase();

  // Both legs must be EU and the sale must cross a border.
  return isEuCountry(origin) && isEuCountry(dest) && origin !== dest;
}
