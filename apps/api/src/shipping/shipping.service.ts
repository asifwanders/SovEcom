/**
 * ShippingService. Resolves the shipping rates AVAILABLE for a
 * cart's destination and computes each one's cost with the pure engine.
 *
 * `availableRates(tenantId, cart)`:
 *   1. destination = cart.shippingAddress?.country — none → [] (zone undeterminable).
 *   2. rates whose zone includes the destination, FILTERED to the cart currency (a
 *      foreign-currency rate must never sum into grandTotal — S5).
 * 3. context: itemsSubtotal = post-discount goods subtotal,
 *      totalWeightGrams = Σ(variant.weight_grams × qty) (null weights = 0).
 *   4. computeRateCost each; drop weight-band misses (null); sort by cost, then name.
 *
 * `resolveSelectedCost` re-derives the cost of the cart's currently-selected rate (used
 * by the totals recompute); null means the selection is no longer available → caller clears it.
 */
import { Injectable } from '@nestjs/common';
import { ShippingRepository } from './shipping.repository';
import { computeRateCost, type ShippingContext } from './shipping.engine';
import type { CartState } from '../cart/cart.types';

export interface AvailableRate {
  id: string;
  name: string;
  type: 'flat' | 'free_over' | 'weight_based';
  /** The COMPUTED cost for this cart, integer minor units (not the raw rate amount). */
  amount: number;
  currency: string;
}

@Injectable()
export class ShippingService {
  constructor(private readonly repo: ShippingRepository) {}

  async availableRates(tenantId: string, cart: CartState): Promise<AvailableRate[]> {
    const destination = cart.shippingAddress?.country;
    if (!destination) return [];

    const rates = (await this.repo.ratesForCountry(tenantId, destination)).filter(
      (r) => r.currency === cart.currency,
    );
    if (rates.length === 0) return [];

    const ctx = await this.buildContext(tenantId, cart);

    const out: AvailableRate[] = [];
    for (const r of rates) {
      const cost = computeRateCost(r, ctx);
      if (cost === null) continue; // weight band does not apply to this cart
      out.push({ id: r.id, name: r.name, type: r.type, amount: cost, currency: r.currency });
    }
    out.sort((a, b) => a.amount - b.amount || a.name.localeCompare(b.name));
    return out;
  }

  /** Cost of the cart's selected rate if still available; null = no longer available. */
  async resolveSelectedCost(tenantId: string, cart: CartState): Promise<number | null> {
    if (!cart.shippingRateId) return null;
    const rates = await this.availableRates(tenantId, cart);
    const selected = rates.find((r) => r.id === cart.shippingRateId);
    return selected ? selected.amount : null;
  }

  /** Post-discount goods subtotal + total cart weight (grams) for the engine. */
  private async buildContext(tenantId: string, cart: CartState): Promise<ShippingContext> {
    const subtotal = cart.items.reduce((s, i) => s + i.unitPriceAmount * i.quantity, 0);
    const itemsSubtotal = Math.max(0, subtotal - (cart.totals?.discountTotal ?? 0));

    const weights = await this.repo.variantWeights(
      tenantId,
      cart.items.map((i) => i.variantId),
    );
    const totalWeightGrams = cart.items.reduce(
      (w, i) => w + (weights.get(i.variantId) ?? 0) * i.quantity,
      0,
    );
    return { itemsSubtotal, totalWeightGrams };
  }
}
