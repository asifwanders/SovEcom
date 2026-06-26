/**
 * `recomputeCartTotals` derives the authoritative `reverseCharge` flag from the
 * tax engine's resolved LINES, never from `taxTotal === 0`.
 *
 * This is the MEDIUM tax-correctness fix: inferring reverse charge from `taxTotal === 0` false-positives
 * on the `none` regime, no-destination carts, zero-rated jurisdictions, and non-EU exports. We prove the
 * flag is TRUE only for a genuine reverse-charge resolution (a tax line carries `reverseCharge`) and
 * FALSE for every taxTotal-0-but-not-reverse-charge case. The tax engine is mocked to return each
 * scenario's authoritative `{ taxTotal, lines }`; the helper must read the lines.
 */
import { recomputeCartTotals } from './cart-totals.helper';
import { CartTotalsCalculator } from './totals/cart-totals.calculator';
import type { CartState } from './cart.types';
import type { TaxResult } from '../taxes/engine/tax-resolver';
import type { DiscountsService } from '../discounts/discounts.service';
import type { TaxesService } from '../taxes/taxes.service';
import type { TenantSettingsService } from '../taxes/tenant-settings.service';
import type { ShippingService } from '../shipping/shipping.service';

const TENANT = 'tenant-1';

function cart(): CartState {
  const now = new Date();
  return {
    id: 'cart-1',
    tenantId: TENANT,
    customerId: null,
    sessionToken: 'tok',
    currency: 'EUR',
    status: 'active',
    guestEmail: null,
    items: [
      {
        id: 'li-1',
        variantId: 'v1',
        quantity: 1,
        unitPriceAmount: 10000,
        currency: 'EUR',
        productTitle: 'Widget',
        variantTitle: null,
        options: {},
        sku: 'W1',
        productSlug: 'widget',
        createdAt: now,
        updatedAt: now,
      },
    ],
    shippingAddress: null,
    billingAddress: null,
    shippingRateId: null,
    shippingAmount: 0,
    discountCode: null,
    totals: {
      subtotal: 0,
      shipping: 0,
      discountTotal: 0,
      taxTotal: 0,
      grandTotal: 0,
      currency: 'EUR',
    },
    expiresAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

/** Wire the helper with stub collaborators; `taxResult` is the authoritative tax-engine output. */
async function recompute(taxResult: TaxResult): Promise<CartState> {
  const c = cart();
  const discounts = { evaluateForCart: async () => ({ discountTotal: 0 }) } as unknown as DiscountsService; // prettier-ignore
  const taxes = { resolveForCart: async () => taxResult } as unknown as TaxesService;
  const settings = { getTaxSettings: async () => ({ pricesIncludeTax: false }) } as unknown as TenantSettingsService; // prettier-ignore
  const shipping = { resolveSelectedCost: async () => 0 } as unknown as ShippingService;
  await recomputeCartTotals(
    TENANT,
    c,
    discounts,
    taxes,
    settings,
    shipping,
    new CartTotalsCalculator(),
  );
  return c;
}

describe('recomputeCartTotals — reverseCharge flag (2c)', () => {
  it('TRUE for a genuine reverse-charge resolution (a tax line carries reverseCharge)', async () => {
    const c = await recompute({
      taxTotal: 0,
      lines: [{ description: 'Items', base: 10000, rate: 0, amount: 0, reverseCharge: true }],
    });
    expect(c.totals.reverseCharge).toBe(true);
    expect(c.totals.taxTotal).toBe(0);
  });

  it('FALSE for the `none` regime (no lines, taxTotal 0)', async () => {
    const c = await recompute({ taxTotal: 0, lines: [] });
    expect(c.totals.taxTotal).toBe(0);
    expect(c.totals.reverseCharge).toBe(false);
  });

  it('FALSE for a domestic eu_vat charge (taxTotal > 0, line NOT reverse charge)', async () => {
    const c = await recompute({
      taxTotal: 2000,
      lines: [{ description: 'Items', base: 10000, rate: 0.2, amount: 2000 }],
    });
    expect(c.totals.taxTotal).toBe(2000);
    expect(c.totals.reverseCharge).toBe(false);
  });

  it('FALSE for a no-destination cart (eu_vat short-circuits to taxTotal 0, no lines)', async () => {
    const c = await recompute({ taxTotal: 0, lines: [] });
    expect(c.totals.reverseCharge).toBe(false);
  });

  it('FALSE for a non-EU export zero-rated line (taxTotal 0, line present but NOT reverseCharge)', async () => {
    // Inclusive non-EU export emits a stripped-base line at rate 0 with NO reverseCharge flag.
    const c = await recompute({
      taxTotal: 0,
      lines: [{ description: 'Items', base: 10000, rate: 0, amount: 0 }],
    });
    expect(c.totals.taxTotal).toBe(0);
    expect(c.totals.reverseCharge).toBe(false);
  });

  it('FALSE for a zero-rated jurisdiction (taxTotal 0, no lines) — not a taxTotal===0 inference', async () => {
    const c = await recompute({ taxTotal: 0, lines: [] });
    expect(c.totals.reverseCharge).toBe(false);
  });
});
