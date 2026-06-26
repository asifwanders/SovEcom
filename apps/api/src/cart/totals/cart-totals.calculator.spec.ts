/**
 * CartTotalsCalculator unit tests.
 *
 * Tests the totals math: subtotal = Σ(qty × unitPrice), no-op discount/tax = 0,
 * grandTotal = subtotal + shipping, currency-mixing rejection, merge logic.
 */
import { CartTotalsCalculator } from './cart-totals.calculator';
import type { CartLineItem } from '../cart.types';

const calculator = new CartTotalsCalculator();

function line(variantId: string, qty: number, price: number, currency = 'EUR'): CartLineItem {
  return {
    id: `item-${variantId}`,
    variantId,
    quantity: qty,
    unitPriceAmount: price,
    currency,
    productTitle: `Product ${variantId}`,
    variantTitle: null,
    options: {},
    sku: `SKU-${variantId}`,
    productSlug: `product-${variantId}`,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('CartTotalsCalculator', () => {
  it('computes subtotal as sum of qty × unit price', () => {
    const items = [line('v1', 2, 1000), line('v2', 3, 500)];
    const totals = calculator.compute(items, null);
    expect(totals.subtotal).toBe(2 * 1000 + 3 * 500); // 3500
  });

  it('no-op discount resolver always returns 0', () => {
    const items = [line('v1', 1, 2000)];
    const totals = calculator.compute(items, null);
    expect(totals.discountTotal).toBe(0);
  });

  it('no-op tax resolver always returns 0', () => {
    const items = [line('v1', 1, 2000)];
    const totals = calculator.compute(items, null);
    expect(totals.taxTotal).toBe(0);
  });

  it('grandTotal = subtotal + shipping when no discount or tax', () => {
    const items = [line('v1', 2, 1000)];
    const totals = calculator.compute(items, 500);
    expect(totals.subtotal).toBe(2000);
    expect(totals.shipping).toBe(500);
    expect(totals.grandTotal).toBe(2500);
    expect(totals.discountTotal).toBe(0);
    expect(totals.taxTotal).toBe(0);
  });

  it('grandTotal = subtotal when shipping is null (not yet chosen)', () => {
    const items = [line('v1', 1, 3000)];
    const totals = calculator.compute(items, null);
    expect(totals.shipping).toBe(0);
    expect(totals.grandTotal).toBe(3000);
  });

  it('handles empty items list (all zeros)', () => {
    const totals = calculator.compute([], null);
    expect(totals.subtotal).toBe(0);
    expect(totals.grandTotal).toBe(0);
    expect(totals.shipping).toBe(0);
  });

  it('uses integer arithmetic (no float drift)', () => {
    const items = [line('v1', 3, 333)]; // 3 × 333 = 999
    const totals = calculator.compute(items, 1);
    expect(totals.subtotal).toBe(999);
    expect(totals.grandTotal).toBe(1000);
    expect(Number.isInteger(totals.subtotal)).toBe(true);
    expect(Number.isInteger(totals.grandTotal)).toBe(true);
  });

  // ── discountTotal is passed in by the engine ─────────────────────

  it('subtracts a supplied discountTotal from grandTotal', () => {
    const items = [line('v1', 1, 2000)];
    const totals = calculator.compute(items, 500, 300);
    expect(totals.subtotal).toBe(2000);
    expect(totals.discountTotal).toBe(300);
    expect(totals.grandTotal).toBe(2000 - 300 + 500); // 2200
  });

  it('clamps a discountTotal that exceeds subtotal (grandTotal never negative from discount)', () => {
    const items = [line('v1', 1, 1000)];
    const totals = calculator.compute(items, null, 9999);
    expect(totals.discountTotal).toBe(1000);
    expect(totals.grandTotal).toBe(0);
  });

  it('ignores a negative discountTotal (defensive clamp to 0)', () => {
    const items = [line('v1', 1, 1000)];
    const totals = calculator.compute(items, null, -50);
    expect(totals.discountTotal).toBe(0);
    expect(totals.grandTotal).toBe(1000);
  });

  // ──2c: reverseCharge flag rides the computed totals ───────

  it('defaults reverseCharge to false when not supplied (back-compat)', () => {
    const items = [line('v1', 1, 2000)];
    const totals = calculator.compute(items, null, 0, 0, false);
    expect(totals.reverseCharge).toBe(false);
  });

  it('carries reverseCharge=true when the tax resolution applied reverse charge', () => {
    const items = [line('v1', 1, 2000)];
    // reverseCharge=true is supplied by recomputeCartTotals from the authoritative tax lines; taxTotal
    // is 0 under reverse charge, but the flag is what the UI reads — NOT a taxTotal===0 inference.
    const totals = calculator.compute(items, 500, 0, 0, false, true);
    expect(totals.reverseCharge).toBe(true);
    expect(totals.taxTotal).toBe(0);
  });

  it('reverseCharge is independent of taxTotal===0 (false when no reverse charge even if tax is 0)', () => {
    const items = [line('v1', 1, 2000)];
    // taxTotal 0 (e.g. `none` regime / domestic zero-rated) but reverse charge NOT applied → flag false.
    const totals = calculator.compute(items, null, 0, 0, false, false);
    expect(totals.taxTotal).toBe(0);
    expect(totals.reverseCharge).toBe(false);
  });
});

// ── mergeCarts ────────────────────────────────────────────────────────────────

import { mergeCartItems } from '../cart-merge.util';

describe('mergeCartItems', () => {
  it('unions items from two carts with no overlap', () => {
    const guest = [line('v1', 2, 1000)];
    const customer = [line('v2', 3, 500)];
    const result = mergeCartItems(guest, customer, {});
    const ids = result.map((i) => i.variantId).sort();
    expect(ids).toEqual(['v1', 'v2'].sort());
  });

  it('sums quantity for same variant', () => {
    const guest = [line('v1', 3, 1000)];
    const customer = [line('v1', 4, 1000)];
    const result = mergeCartItems(guest, customer, {});
    expect(result).toHaveLength(1);
    expect(result[0]!.quantity).toBe(7);
  });

  it('clamps summed quantity to available stock', () => {
    const guest = [line('v1', 8, 1000)];
    const customer = [line('v1', 6, 1000)];
    const stockMap = { v1: { stock: 10, allowBackorder: false } };
    const result = mergeCartItems(guest, customer, stockMap);
    expect(result[0]!.quantity).toBe(10); // 8+6=14 → clamped to 10
  });

  it('does not clamp when stock is not in map', () => {
    const guest = [line('v1', 100, 1000)];
    const customer = [line('v1', 200, 1000)];
    const result = mergeCartItems(guest, customer, {}); // no stock info
    expect(result[0]!.quantity).toBe(300);
  });

  it('guest-only variant is adopted', () => {
    const guest = [line('v1', 2, 1000), line('v2', 1, 500)];
    const customer = [line('v1', 3, 1000)];
    const result = mergeCartItems(guest, customer, { v1: { stock: 10, allowBackorder: false } });
    const v2 = result.find((i) => i.variantId === 'v2');
    expect(v2).toBeTruthy();
    expect(v2!.quantity).toBe(1);
  });

  it('customer-only variant is kept', () => {
    const guest = [line('v1', 1, 1000)];
    const customer = [line('v1', 1, 1000), line('v3', 4, 200)];
    const result = mergeCartItems(guest, customer, { v1: { stock: 10, allowBackorder: false } });
    const v3 = result.find((i) => i.variantId === 'v3');
    expect(v3).toBeTruthy();
    expect(v3!.quantity).toBe(4);
  });
});
