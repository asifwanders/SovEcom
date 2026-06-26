/**
 * Shared EU VAT guardrail.
 *
 * The SINGLE source of truth for the "an EU-based merchant must not silently run
 * `tax_mode='none'`" rule. Extracted from the admin taxes controller so BOTH the admin
 * settings PUT and the setup-wizard `tax/configure` step enforce the IDENTICAL rule —
 * a divergent copy could let the wizard write a tax-illegal config the admin screen
 * would reject (or vice-versa).
 *
 * The rule is purely a function of the EFFECTIVE post-update `(taxMode, originCountry)`
 * pair; callers compute the effective values (patched-or-current) and pass them in. On a
 * violation it throws `UnprocessableEntityException` (NestJS 422) with a plain-language
 * message; on success it returns void.
 */
import { UnprocessableEntityException } from '@nestjs/common';
import { isEuCountry } from './engine/eu-vat-rules';

/**
 * Enforce the EU VAT guardrail for an effective `(taxMode, originCountry)` pair.
 *
 * - `tax_mode='none'` while EITHER the effective OR the current origin is EU-27 → 422
 *   (an EU VAT-registered merchant cannot legally disable VAT; checking the current
 *   origin too prevents "clear origin + set none" in one request from bypassing it).
 * - `tax_mode='eu_vat'` with no effective origin → 422 (below-threshold origin-VAT and
 *   cross-border reverse-charge both require knowing the merchant's country).
 *
 * @param effectiveMode    the post-update tax mode
 * @param effectiveOrigin  the post-update origin country (ISO α-2) or null
 * @param currentOrigin    the EXISTING origin country (defaults to `effectiveOrigin`
 *                         when there is no prior state, e.g. the setup wizard)
 */
export function enforceEuGuardrail(
  effectiveMode: 'none' | 'eu_vat',
  effectiveOrigin: string | null | undefined,
  currentOrigin: string | null | undefined = effectiveOrigin,
): void {
  if (effectiveMode === 'none' && (isEuCountry(effectiveOrigin) || isEuCountry(currentOrigin))) {
    throw new UnprocessableEntityException(
      `Cannot set tax_mode='none' for an EU-based business (origin ` +
        `${effectiveOrigin ?? currentOrigin}). ` +
        'An EU VAT-registered merchant must charge VAT — use tax_mode=eu_vat.',
    );
  }

  if (effectiveMode === 'eu_vat' && !effectiveOrigin) {
    throw new UnprocessableEntityException(
      "tax_mode='eu_vat' requires an origin country (the merchant's country).",
    );
  }
}
