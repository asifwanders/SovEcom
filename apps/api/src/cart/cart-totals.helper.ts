/**
 *  2.6 — shared cart-totals recompute (CartService + CartAssociateService).
 *
 * Evaluates discounts via the engine (async, DB-backed), THEN resolves tax via the
 * tax engine (async, DB-backed — selects the tenant's regime + reads tax_rates), then
 * computes the integer totals. Kept as a free function so
 * both cart services recompute identically without duplicating the wiring.
 *
 * Ordering matters: tax is computed on the base NET OF DISCOUNT, so discounts run
 * first and the discountTotal is written onto `cart.totals` BEFORE TaxesService reads
 * it (resolveForCart derives the taxable items base = subtotal − discountTotal).
 */
import type { CartState } from './cart.types';
import type { DiscountsService } from '../discounts/discounts.service';
import type { TaxesService } from '../taxes/taxes.service';
import type { TenantSettingsService } from '../taxes/tenant-settings.service';
import type { ShippingService } from '../shipping/shipping.service';
import type { CartTotalsCalculator } from './totals/cart-totals.calculator';

export async function recomputeCartTotals(
  tenantId: string,
  cart: CartState,
  discounts: DiscountsService,
  taxes: TaxesService,
  settings: TenantSettingsService,
  shipping: ShippingService,
  calculator: CartTotalsCalculator,
): Promise<void> {
  // Discount eligibility is derived from the cart OWNER inside evaluateForCart, not a
  // request principal — so no `customer` is threaded here (/ #2).
  const { discountTotal } = await discounts.evaluateForCart(tenantId, cart, cart.discountCode);

  // Stamp the discountTotal onto the cart BEFORE shipping + tax read it — shipping's
  // free_over base and tax's taxable base both derive from subtotal − discountTotal.
  cart.totals = { ...cart.totals, discountTotal, currency: cart.currency };

  // Re-evaluate the SELECTED shipping rate: a free_over rate can flip and a
  // weight band can change as the cart changes; if the rate is no longer available for the
  // destination (e.g. address moved out of zone) the selection is cleared. Must run BEFORE
  // tax — tax includes the shipping amount as a taxable component.
  if (cart.shippingRateId) {
    const cost = await shipping.resolveSelectedCost(tenantId, cart);
    if (cost === null) {
      cart.shippingRateId = null;
      cart.shippingAmount = 0;
    } else {
      cart.shippingAmount = cost;
    }
  } else {
    cart.shippingAmount = 0;
  }

  const [taxResult, taxSettings] = await Promise.all([
    taxes.resolveForCart(tenantId, cart),
    settings.getTaxSettings(tenantId),
  ]);

  // Reverse charge is the AUTHORITATIVE tax-engine decision: true IFF a resolved
  // tax line carries `reverseCharge` (EuVatResolver flags every line on a VIES-validated B2B cross-border
  // EU sale). Deriving it from `taxTotal === 0` would false-positive on the `none` regime, no-destination
  // carts, zero-rated jurisdictions, and non-EU exports — so we read the lines, never the total.
  const reverseCharge = taxResult.lines.some((line) => line.reverseCharge === true);

  const totals = calculator.compute(
    cart.items,
    cart.shippingAmount,
    discountTotal,
    taxResult.taxTotal,
    taxSettings.pricesIncludeTax,
    reverseCharge,
  );
  cart.totals = { ...totals, currency: cart.currency };
}
