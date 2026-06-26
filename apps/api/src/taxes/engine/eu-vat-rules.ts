/**
 * EU VAT rules data + integer money helpers.
 *
 * The 27 EU member-state STANDARD VAT rates (source: EU Commission "VAT rates
 * applied in the Member States", reviewed yearly). These drive BOTH the `tax_rates`
 * seed (seed.ts) and the membership test the engine uses (EU vs non-EU destination,
 * cross-border detection). Rates here are the source of truth for the seed; the
 * engine itself reads the live `tax_rates` row at runtime (a merchant may edit it),
 * but uses `EU_MEMBER_STATES` for the EU-membership decision.
 *
 * Out of scope for v1: special territories (Canary Islands, Ceuta, Melilla,
 * Channel Islands, Åland, etc.) and digital-goods rules. Physical goods, standard
 * rate, mainland only.
 */

/**
 * The 27 EU member states with their STANDARD VAT rate (as a fraction).
 * As of 2026 (rates change occasionally — check for yearly updates).
 */
export const EU_STANDARD_RATES: ReadonlyMap<string, number> = new Map([
  ['AT', 0.2], // Austria
  ['BE', 0.21], // Belgium
  ['BG', 0.2], // Bulgaria
  ['HR', 0.25], // Croatia
  ['CY', 0.19], // Cyprus
  ['CZ', 0.21], // Czechia
  ['DK', 0.25], // Denmark
  ['EE', 0.24], // Estonia — standard VAT rose 22% → 24% on 2025-07-01
  ['FI', 0.255], // Finland
  ['FR', 0.2], // France
  ['DE', 0.19], // Germany
  ['GR', 0.24], // Greece
  ['HU', 0.27], // Hungary
  ['IE', 0.23], // Ireland
  ['IT', 0.22], // Italy
  ['LV', 0.21], // Latvia
  ['LT', 0.21], // Lithuania
  ['LU', 0.17], // Luxembourg
  ['MT', 0.18], // Malta
  ['NL', 0.21], // Netherlands
  ['PL', 0.23], // Poland
  ['PT', 0.23], // Portugal
  ['RO', 0.21], // Romania
  ['SK', 0.23], // Slovakia
  ['SI', 0.22], // Slovenia
  ['ES', 0.21], // Spain
  ['SE', 0.25], // Sweden
]);

/** ISO codes of the 27 EU member states (membership test). */
export const EU_MEMBER_STATES: ReadonlySet<string> = new Set(EU_STANDARD_RATES.keys());

/** True if `country` (ISO 3166-1 alpha-2, any case) is an EU-27 member state. */
export function isEuCountry(country: string | null | undefined): boolean {
  return country != null && EU_MEMBER_STATES.has(country.toUpperCase());
}

/**
 * Compute the VAT for a single taxable base.
 *
 * - EXCLUSIVE pricing: tax is ADDED on top → `round_half_up(base × rate)`.
 * - INCLUSIVE pricing: the base is GROSS, tax is EXTRACTED →
 *   `gross − round_half_up(gross / (1 + rate))`.
 *
 * Integer minor units throughout; round HALF-UP; clamp ≥ 0. `rate` is the fraction
 * form of the NUMERIC(5,4) column (0.2000 → 0.2).
 */
export function computeVat(base: number, rate: number, pricesIncludeTax: boolean): number {
  if (rate <= 0 || base <= 0) return 0;
  const tax = pricesIncludeTax ? base - roundHalfUp(base / (1 + rate)) : roundHalfUp(base * rate);
  return Math.max(0, tax);
}

/**
 * Round half-up to the nearest integer minor unit. Math.round already rounds .5
 * toward +∞ for positive numbers; we guard negatives explicitly so the rule holds
 * regardless of sign (bases are non-negative here, but keep the helper total).
 */
export function roundHalfUp(value: number): number {
  return value >= 0 ? Math.floor(value + 0.5) : -Math.floor(-value + 0.5);
}
