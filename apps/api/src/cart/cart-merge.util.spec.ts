/**
 * mergeCartItems unit tests (guest→customer).
 */
import { mergeCartItems, type MergeStockInfo } from './cart-merge.util';
import type { CartLineItem } from './cart.types';

function item(variantId: string, quantity: number): CartLineItem {
  const now = new Date('2026-01-01T00:00:00Z');
  return {
    id: `item-${variantId}`,
    variantId,
    quantity,
    unitPriceAmount: 1000,
    currency: 'EUR',
    productTitle: `Product ${variantId}`,
    variantTitle: null,
    options: {},
    sku: `SKU-${variantId}`,
    productSlug: `product-${variantId}`,
    createdAt: now,
    updatedAt: now,
  };
}

const stock = (n: number, allowBackorder = false): MergeStockInfo => ({ stock: n, allowBackorder });

describe('mergeCartItems', () => {
  it('unions disjoint items from both carts', () => {
    const merged = mergeCartItems([item('a', 1)], [item('b', 2)], { a: stock(10), b: stock(10) });
    expect(merged).toHaveLength(2);
    expect(merged.find((i) => i.variantId === 'a')?.quantity).toBe(1);
    expect(merged.find((i) => i.variantId === 'b')?.quantity).toBe(2);
  });

  it('sums quantities for a variant in both carts', () => {
    const merged = mergeCartItems([item('a', 8)], [item('a', 6)], { a: stock(100) });
    expect(merged).toHaveLength(1);
    expect(merged[0]!.quantity).toBe(14);
  });

  it('clamps a summed non-backorder line to available stock', () => {
    const merged = mergeCartItems([item('a', 8)], [item('a', 6)], { a: stock(10) });
    expect(merged[0]!.quantity).toBe(10); // 14 clamped to 10
  });

  it('drops a non-backorder line whose stock is 0 (would poison the flush)', () => {
    const merged = mergeCartItems([item('a', 5)], [], { a: stock(0) });
    expect(merged).toHaveLength(0);
  });

  it('does NOT clamp or drop a backorder line — keeps the full summed quantity', () => {
    const merged = mergeCartItems([item('a', 10)], [item('a', 3)], { a: stock(0, true) });
    expect(merged).toHaveLength(1);
    expect(merged[0]!.quantity).toBe(13); // backorder → never clamped to stock
  });

  it('leaves quantities unclamped when stock info is absent', () => {
    const merged = mergeCartItems([item('a', 50)], [], {});
    expect(merged[0]!.quantity).toBe(50);
  });
});
