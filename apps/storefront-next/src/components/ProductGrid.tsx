/**
 * Product grid for the catalog listing surfaces.
 *
 * Maps the product view-type to the reusable `ProductCard` so home / PLP / category / search share
 * one card. Visual output is UNCHANGED — the grid classes and card markup are the same as before
 * the extraction.
 *
 * The per-card `product-card-actions` module slot is rendered by the async `<Slot>` RSC,
 * which cannot run inside this SYNC grid. So the grid accepts an optional `cardActions(product)` that an
 * async caller supplies (pre-rendering `<Slot name="product-card-actions" route=… />` per product) and
 * threads to each `ProductCard`'s `actions` seam. Absent (the default for the catalog surfaces today),
 * the seam renders nothing and the DOM is byte-identical to before — keeping every existing section spec
 * green without converting the whole grid/section chain to async.
 */
import type { ReactNode } from 'react';
import { ProductCard } from './ProductCard';
import type { ProductCardView } from '@/lib/catalog';

export function ProductGrid({
  products,
  locale,
  cardActions,
}: {
  products: ProductCardView[];
  /** Active locale — threaded into ProductCard for locale-aware price formatting. */
  locale?: string;
  /**
   * Optional per-card `product-card-actions` slot node provider. An async caller renders
   * `<Slot name="product-card-actions" route={`/product/${product.slug}`} />` and returns it here;
   * absent means no actions seam (prior output unchanged).
   */
  cardActions?: (product: ProductCardView) => ReactNode;
}) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
      {products.map((product) => (
        <ProductCard
          key={product.id}
          product={product}
          locale={locale}
          actions={cardActions?.(product)}
        />
      ))}
    </div>
  );
}
