/**
 * TaxResolver strategy.
 *
 * Tax is a per-tenant REGIME selected by `tax_mode`. Each resolver takes a pure,
 * pre-built input (no DB, no request principal) and returns the integer tax total
 * plus a per-line breakdown. `taxes.service` picks the resolver from the tenant's
 * `tax_mode` and builds the input from the CART + the cart OWNER.
 *
 * All money is integer MINOR UNITS (cents). Never floats — tax carries legal weight.
 */

/** A taxable component of the cart (line items collapsed to a base + shipping). */
export interface TaxableComponent {
  /** Human-readable label, e.g. "Items" or "Shipping". */
  description: string;
  /**
   * The taxable BASE in integer minor units. For tax-EXCLUSIVE pricing this is the
   * net amount tax is added to; for tax-INCLUSIVE it is the GROSS amount tax is
   * extracted from. The resolver branches on `pricesIncludeTax`.
   */
  amount: number;
}

/** The pure input a resolver consumes. Built by `taxes.service.resolveForCart`. */
export interface TaxInput {
  /** Currency code (ISO 4217) — carried through onto every line for integrity. */
  currency: string;
  /** Destination country (ISO 3166-1 alpha-2, upper-cased) from the shipping address, or null. */
  destinationCountry: string | null;
  /** Taxable components (items net-of-discount, shipping). */
  components: TaxableComponent[];
  /**
   * Whether catalogue prices already INCLUDE tax. Inclusive → extract the tax from
   * the gross; exclusive → add tax on top. Orthogonal to the regime.
   */
  pricesIncludeTax: boolean;
  /** The cart OWNER's B2B / VAT status (null for a guest cart). */
  customer: TaxCustomerContext | null;
}

/** The cart owner's tax-relevant attributes (from `customers`, tenant-scoped). */
export interface TaxCustomerContext {
  isB2b: boolean;
  /** True only when the VAT number was positively VIES-validated (`vat_validated`). */
  vatValidated: boolean;
}

/** One computed tax line in the breakdown. */
export interface TaxLine {
  description: string;
  /** The taxable base (net for exclusive, gross for inclusive), integer minor units. */
  base: number;
  /** The applied rate as a fraction (e.g. 0.2 for 20%). 0 for reverse charge / no-VAT. */
  rate: number;
  /** The tax amount, integer minor units, clamped ≥ 0. */
  amount: number;
  /** Set when B2B reverse charge applies (0% VAT, customer self-accounts). */
  reverseCharge?: boolean;
}

/** What every resolver returns. */
export interface TaxResult {
  /** Σ of the line amounts, integer minor units, ≥ 0. */
  taxTotal: number;
  lines: TaxLine[];
}

/** The strategy contract. Implementations: NoneResolver, EuVatResolver. */
export interface TaxResolver {
  resolve(input: TaxInput): TaxResult;
}
