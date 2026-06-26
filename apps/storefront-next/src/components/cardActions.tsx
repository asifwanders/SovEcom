/**
 * C3 — the shared `product-card-actions` slot provider.
 *
 * Activates the per-card module slot C2 left as a seam on `ProductGrid`/`ProductCard`. Each catalog
 * grid passes {@link productCardActions} as its `cardActions` prop; the grid threads the returned node
 * to each card's `actions` seam (a SIBLING of the card link, never nested in the anchor).
 *
 * The slot's bound widget (wishlist → `toggle-button`) is PERSONALIZED, so `<Slot>` renders it as the
 * C2 client island — the per-card cost is a binding resolve (the slot map is `cache()`-shared across
 * the whole page, ONE round-trip) plus an island shell. When no module binds `product-card-actions`
 * (the default — e.g. CI with no modules), `<Slot>` renders NOTHING and the card DOM is unchanged.
 *
 * `route` carries the PRODUCT ID (C3 note): the module's gated catalog read is id-keyed, and the
 * wishlist toggle keys its add/remove on this id.
 */
import type { ReactNode } from 'react';
import { Slot } from '@/components/Slot';
import type { ProductCardView } from '@/lib/catalog';

/** Render the `product-card-actions` slot for one product card (an async RSC node). */
export function productCardActions(product: ProductCardView): ReactNode {
  return <Slot name="product-card-actions" route={product.id} />;
}
