/**
 * `eu_vat` tax regime: the EU VAT engine.
 *
 * Pure + synchronous (no DB, no request principal). The service resolves the live
 * rates from `tax_rates` and the tenant's EU-VAT registration, then constructs this
 * resolver bound to that {@link EuVatContext}; `resolve(input)` applies the rules.
 *
 * Decision order (steps 1–5):
 *   1. Destination from the cart shipping address. No destination → tax 0 (can't
 *      determine the rate; the service short-circuits, but we guard here too).
 *   2. Destination NON-EU → no EU VAT (taxTotal 0).
 *   3. B2B cross-border + VIES-validated → REVERSE CHARGE: 0% VAT, line flagged.
 *   4. OSS €10k threshold (B2C cross-border EU only):
 *        - below_threshold      → charge ORIGIN-country VAT (merchant's own rate).
 *        - above_or_opted_in    → charge DESTINATION-country VAT (OSS-reportable).
 *      B2B same-country & domestic B2C → DESTINATION (= local) rate.
 *   5. Per component, compute tax inclusive (extract) or exclusive (add).
 *
 * Integer minor units; round HALF-UP; clamp ≥ 0 (all in eu-vat-rules.computeVat).
 */
import type { TaxInput, TaxLine, TaxResolver, TaxResult } from './tax-resolver';
import { computeVat, isEuCountry, roundHalfUp } from './eu-vat-rules';
import { reverseChargeApplies } from './reverse-charge';

/** Tenant + rate context the service injects (resolved from settings + tax_rates). */
export interface EuVatContext {
  /** The merchant's EU country of establishment (tenant `originCountry`), or null. */
  originCountry: string | null;
  /** OSS posture. Drives origin-vs-destination for cross-border B2C. */
  ossPosture: 'below_threshold' | 'above_or_opted_in';
  /**
   * Resolved STANDARD VAT rate for the DESTINATION country (fraction, e.g. 0.2),
   * or null when no `tax_rates` row exists for it.
   */
  destinationRate: number | null;
  /** Resolved STANDARD VAT rate for the ORIGIN country (fraction), or null. */
  originRate: number | null;
}

export class EuVatResolver implements TaxResolver {
  constructor(private readonly ctx: EuVatContext) {}

  resolve(input: TaxInput): TaxResult {
    const dest = input.destinationCountry?.toUpperCase() ?? null;
    const origin = this.ctx.originCountry?.toUpperCase() ?? null;

    // (1) No destination → cannot determine anything (no rate, no origin to strip) → no tax.
    if (!dest) {
      return { taxTotal: 0, lines: [] };
    }

    // (2) Non-EU destination → no EU VAT (zero-rated export). Under tax-INCLUSIVE pricing
    //     the sticker amount embeds the merchant's ORIGIN VAT; booking the gross would
    //     overcharge the buyer the now-non-applicable VAT, so re-derive the NET base by
    //     stripping the origin rate. With no origin rate known there is nothing to strip
    //     (and no rate to guess) → emit nothing, as before.
    if (!isEuCountry(dest)) {
      return this.zeroRated(input, this.ctx.originRate, /* reverseCharge */ false);
    }

    // (3) B2B cross-border reverse charge → 0% VAT, every line flagged. Under tax-INCLUSIVE
    //     pricing the embedded VAT (the DESTINATION rate the buyer self-accounts at) must be
    //     stripped from the base, else the VIES-validated B2B buyer is overcharged it and the
    //     invoice is non-compliant. The charged VAT stays 0.
    if (
      reverseChargeApplies({
        customer: input.customer,
        originCountry: origin,
        destinationCountry: dest,
      })
    ) {
      return this.zeroRated(input, this.ctx.destinationRate, /* reverseCharge */ true);
    }

    // (4) Pick the applicable rate.
    // - Cross-border B2C below threshold → ORIGIN rate.
    // - Otherwise → DESTINATION rate (domestic, or above-threshold cross-border,
    //   or B2B-without-reverse-charge which falls here as a local/destination charge).
    const isB2c = !(input.customer?.isB2b ?? false);
    const crossBorder = origin != null && origin !== dest;
    const useOriginRate = isB2c && crossBorder && this.ctx.ossPosture === 'below_threshold';

    const rate = useOriginRate ? this.ctx.originRate : this.ctx.destinationRate;

    // No rate row for the chosen country → charge nothing (fail safe; the merchant
    // must seed the rate). Never guess.
    if (rate == null || rate <= 0) {
      return { taxTotal: 0, lines: [] };
    }

    // (5) Compute per component.
    const lines: TaxLine[] = [];
    let taxTotal = 0;
    for (const c of input.components) {
      if (c.amount <= 0) continue;
      const amount = computeVat(c.amount, rate, input.pricesIncludeTax);
      taxTotal += amount;
      lines.push({ description: c.description, base: c.amount, rate, amount });
    }

    return { taxTotal: Math.max(0, taxTotal), lines };
  }

  /**
   * Build the line breakdown for a ZERO-VAT outcome (reverse charge, or non-EU export).
   * The charged VAT is always 0. Under tax-INCLUSIVE pricing the component amount is the
   * GROSS sticker price with the embedded VAT baked in; we must re-derive the NET base by
   * stripping `wouldBeRate` (the rate that WOULD have applied — destination for reverse
   * charge, origin for an export) — otherwise the buyer is overcharged the embedded VAT and
   * the order/invoice books the gross against taxAmount 0. Integer cents, round HALF-UP
   * (mirrors the inclusive extraction in eu-vat-rules.computeVat).
   *
   * When `wouldBeRate` is null/≤0 there is no rate to strip — we never guess:
   *   - reverse charge: still emit the flagged line at its given base (unchanged exclusive
   *     behaviour, and the no-rate inclusive case must not silently drop a B2B line);
   *   - non-EU export: emit nothing (matches the prior fail-safe: a non-EU sale carried no
   *     EU-VAT lines, and with no rate there is nothing to strip).
   */
  private zeroRated(
    input: TaxInput,
    wouldBeRate: number | null,
    reverseCharge: boolean,
  ): TaxResult {
    const canStrip = input.pricesIncludeTax && wouldBeRate != null && wouldBeRate > 0;
    const lines: TaxLine[] = [];
    for (const c of input.components) {
      if (c.amount <= 0) continue;
      // Non-EU export: a line is emitted ONLY to carry the stripped NET base under inclusive
      // pricing. Exclusive (or inclusive-with-no-rate) export emits nothing, exactly as before.
      if (!reverseCharge && !canStrip) continue;
      const base = canStrip ? roundHalfUp(c.amount / (1 + wouldBeRate!)) : c.amount;
      const line: TaxLine = { description: c.description, base, rate: 0, amount: 0 };
      if (reverseCharge) line.reverseCharge = true;
      lines.push(line);
    }
    return { taxTotal: 0, lines };
  }
}
