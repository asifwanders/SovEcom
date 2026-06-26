/**
 * TaxesService — The resolver-selection seam.
 *
 * `resolveForCart` is what the cart calls inside recomputeTotals (mirrors how
 * discounts are wired). It:
 *   1. Loads the tenant's tax settings (TenantSettingsService).
 *   2. Selects the resolver by `tax_mode` (`none` → NoneResolver; `eu_vat` →
 *      EuVatResolver bound to the tenant's EU context + live rates).
 *   3. Builds the PURE input from the CART + the cart OWNER (NOT a request principal):
 *      taxable base = items net-of-discount, plus shipping; destination =
 *      cart.shippingAddress?.country; customer = the cart owner's b2b/vat status via
 *      cart.customerId.
 *   4. Returns `{ taxTotal, lines }`.
 *
 * `eu_vat` with NO shipping address yet → taxTotal 0 (destination undeterminable)
 * until an address is set. All money is integer minor units; every query tenant-scoped.
 */
import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { customers } from '../database/schema/customers';
import { TenantSettingsService } from './tenant-settings.service';
import { TaxesRepository } from './taxes.repository';
import { NoneResolver } from './engine/none-resolver';
import { EuVatResolver } from './engine/eu-vat-resolver';
import type {
  TaxCustomerContext,
  TaxInput,
  TaxResult,
  TaxableComponent,
} from './engine/tax-resolver';
import type { CartState } from '../cart/cart.types';

const NONE_RESULT: TaxResult = { taxTotal: 0, lines: [] };

@Injectable()
export class TaxesService {
  private readonly noneResolver = new NoneResolver();

  constructor(
    private readonly db: DatabaseService,
    private readonly settings: TenantSettingsService,
    private readonly repo: TaxesRepository,
  ) {}

  /**
   * Resolve the tax for a cart. Loads tenant settings, selects the resolver, builds
   * the input from the cart + its owner, returns the integer tax total + lines.
   */
  async resolveForCart(tenantId: string, cart: CartState): Promise<TaxResult> {
    const settings = await this.settings.getTaxSettings(tenantId);

    // `none` regime → never reads tax_rates, never touches the cart owner.
    if (settings.taxMode === 'none') {
      return this.noneResolver.resolve(this.buildBaseInput(cart, null, settings.pricesIncludeTax));
    }

    // eu_vat regime.
    const destinationCountry = normaliseCountry(cart.shippingAddress?.country ?? null);

    // No destination yet → cannot determine the rate → tax 0 until an address is set.
    if (!destinationCountry) return NONE_RESULT;

    const customer = await this.loadCustomerContext(tenantId, cart.customerId);
    const input = this.buildBaseInput(cart, customer, settings.pricesIncludeTax);
    input.destinationCountry = destinationCountry;

    const origin = settings.euVatRegistration.originCountry;
    const [destinationRate, originRate] = await Promise.all([
      this.repo.countryRate(tenantId, destinationCountry),
      origin ? this.repo.countryRate(tenantId, origin) : Promise.resolve(null),
    ]);

    const resolver = new EuVatResolver({
      originCountry: origin,
      ossPosture: settings.ossPosture,
      destinationRate,
      originRate,
    });
    return resolver.resolve(input);
  }

  // ── Input builders ────────────────────────────────────────────────────────────

  /**
   * Build the pure resolver input. Taxable base = items net-of-discount (the
   * subtotal minus the already-computed cart discountTotal, never < 0), as ONE
   * "Items" component, plus a separate "Shipping" component. Splitting items vs
   * shipping keeps the breakdown legible; both use the same destination rate in v1.
   */
  private buildBaseInput(
    cart: CartState,
    customer: TaxCustomerContext | null,
    pricesIncludeTax: boolean,
  ): TaxInput {
    const subtotal = cart.items.reduce((s, i) => s + i.unitPriceAmount * i.quantity, 0);
    const discount = Math.max(0, Math.min(cart.totals?.discountTotal ?? 0, subtotal));
    const itemsBase = Math.max(0, subtotal - discount);
    const shipping = Math.max(0, cart.shippingAmount ?? 0);

    const components: TaxableComponent[] = [];
    if (itemsBase > 0) components.push({ description: 'Items', amount: itemsBase });
    if (shipping > 0) components.push({ description: 'Shipping', amount: shipping });

    return {
      currency: cart.currency,
      destinationCountry: null,
      components,
      pricesIncludeTax,
      customer,
    };
  }

  /**
   * The cart OWNER's b2b/vat status (tenant-scoped) — drives reverse charge from the
   * cart owner, NOT the request principal. A guest cart has no context.
   */
  private async loadCustomerContext(
    tenantId: string,
    customerId: string | null,
  ): Promise<TaxCustomerContext | null> {
    if (!customerId) return null;
    const [row] = await this.db.db
      .select({ isB2b: customers.isB2b, vatValidated: customers.vatValidated })
      .from(customers)
      .where(and(eq(customers.id, customerId), eq(customers.tenantId, tenantId)))
      .limit(1);
    if (!row) return null;
    return { isB2b: row.isB2b, vatValidated: row.vatValidated };
  }
}

/** Upper-case + validate a 2-letter country code; null if absent/malformed. */
function normaliseCountry(country: string | null): string | null {
  if (!country) return null;
  const c = country.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(c) ? c : null;
}
