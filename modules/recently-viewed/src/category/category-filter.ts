/**
 * recently-viewed — the `excludeCategories` filter seam.
 *
 * Doc 13 lets an admin configure category ids whose products are NEVER surfaced in the
 * recently-viewed list. To honour it the module must, for a candidate product, learn WHICH
 * categories that product belongs to and drop it when any is in the exclude set.
 *
 * GAP CLOSED (follow-up B1): the gated `read:products` surface now carries the product's PRIMARY
 * category on `ModuleProductDto.category = { id, slug, name }`. So a product's category CAN be
 * resolved end-to-end through `sdk.store.products(productId)` — no new permission (it rides the
 * existing `read:products` grant).
 *
 * The filter stays a single injectable SEAM — {@link ProductCategoryResolver} — so tests can still
 * stub it. The RUNTIME default is now {@link storeProductCategoryResolver}, which reads the product's
 * category id from the catalog read. {@link excludeNothingResolver} is retained (it is the honest
 * "categories unknown → exclude nothing" fallback) for callers that have no catalog read. The module
 * wires the real resolver in `activate()`. See README "Category exclusion".
 */
import type { StoreClient } from '@sovecom/module-sdk';

/** Resolves the set of category ids a product belongs to (or empty when unknown). */
export interface ProductCategoryResolver {
  /** Category ids for `productId`. An empty set means "no/unknown categories" → never excluded. */
  categoriesOf(productId: string): Promise<ReadonlySet<string>>;
}

/**
 * The "categories unknown" fallback: resolves every product to NO categories, so nothing is excluded
 * by category. Retained for callers without a catalog read; the live module uses
 * {@link storeProductCategoryResolver} instead. The name says exactly what it does — it excludes
 * nothing — never a fake pass that would hide a product the admin wanted hidden.
 */
export const excludeNothingResolver: ProductCategoryResolver = {
  categoriesOf: () => Promise.resolve(new Set<string>()),
};

/**
 * The RUNTIME default (B1): resolve a product's category id from the gated `read:products` read
 * (`ModuleProductDto.category`). A product carries at most its PRIMARY category, so the returned set
 * holds 0 or 1 id. A failed/empty lookup degrades to the empty set (→ never excluded — availability
 * wins; the same fail-open posture {@link isExcludedByCategory} already documents).
 */
export function storeProductCategoryResolver(
  products: StoreClient['products'],
): ProductCategoryResolver {
  return {
    async categoriesOf(productId: string): Promise<ReadonlySet<string>> {
      try {
        const dto = await products.get(productId);
        const id = dto?.category?.id;
        return id ? new Set<string>([id]) : new Set<string>();
      } catch {
        return new Set<string>();
      }
    },
  };
}

/**
 * True if `productId` should be EXCLUDED given the configured `excludeCategories`. Fast-paths the
 * common case (no exclusions configured → never excluded, no resolver call). On a resolver error it
 * FAILS OPEN to "not excluded" — by design, availability beats hiding: a rail degrading to show one
 * extra product is far less harmful than the resolver error blanking the whole feature. (The default
 * resolver never throws anyway.)
 */
export async function isExcludedByCategory(
  productId: string,
  excludeCategories: readonly string[],
  resolver: ProductCategoryResolver,
): Promise<boolean> {
  if (excludeCategories.length === 0) return false;
  let cats: ReadonlySet<string>;
  try {
    cats = await resolver.categoriesOf(productId);
  } catch {
    return false;
  }
  if (cats.size === 0) return false;
  for (const excluded of excludeCategories) {
    if (cats.has(excluded)) return true;
  }
  return false;
}
