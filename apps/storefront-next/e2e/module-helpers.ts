/**
 * Module-render E2E helpers (storefront side).
 *
 * The admin side (`apps/admin/e2e/module-install.spec.ts`) installs and enables the bundled `reviews`
 * module; this side asserts the resulting `review-list` widget reaches the storefront via the slot render
 * runtime. The install persists in the DB, so the admin spec must run first (documented ordering
 * dependency); these helpers are self-guarded and the storefront spec `test.skip`s if the module isn't
 * enabled yet.
 *
 * `reviews` is the chosen module because `review-list` is the only bundled widget that renders as
 * read-only and anonymous (`personalized: false`) — server-fetched, route-keyed, and SEO-visible. The
 * storefront "customer sees it" surface is fully exercisable here. Personalized or persisted customer
 * interaction (wishlist toggle state, etc.) is deferred and would require additional identity-into-island
 * wiring.
 */
import { request as playwrightRequest } from '@playwright/test';
import { E2E_PRODUCT_SLUG } from './fixtures';

/** The bundled module + its slot/widget (mirrors `reviews/sovecom.module.json` + the admin helper). */
export const REVIEWS_MODULE = 'reviews';
export const REVIEWS_SLOT = 'product-detail-reviews-section';
export const REVIEWS_WIDGET = 'review-list';

/** The API origin the storefront SSR + these probes hit (mirrors the storefront fixtures' default). */
const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3000';

/** Whether the reviews slot binding is live in the public slot map (`GET /store/v1/slots`). */
export async function reviewsSlotBound(): Promise<boolean> {
  const ctx = await playwrightRequest.newContext({ baseURL: API_BASE_URL });
  try {
    const res = await ctx.get('/store/v1/slots');
    if (!res.ok()) return false;
    const map = (await res.json()) as Record<string, { module?: string; component?: string }>;
    const binding = map?.[REVIEWS_SLOT];
    return binding?.module === REVIEWS_MODULE && binding?.component === REVIEWS_WIDGET;
  } catch {
    return false;
  } finally {
    await ctx.dispose();
  }
}

/** Resolve the seeded fixture product's id (the PDP slot's `route` key is the product id, not slug). */
export async function fixtureProductId(): Promise<string | null> {
  const ctx = await playwrightRequest.newContext({ baseURL: API_BASE_URL });
  try {
    const res = await ctx.get(`/store/v1/products/${E2E_PRODUCT_SLUG}`);
    if (!res.ok()) return null;
    const product = (await res.json()) as { id?: string };
    return typeof product?.id === 'string' ? product.id : null;
  } catch {
    return null;
  } finally {
    await ctx.dispose();
  }
}

/**
 * Fetch the reviews module's slot descriptor for a product, exactly as the storefront SSR does
 * (`GET /store/v1/modules/reviews/slot?slot=&route=<productId>`, no credentials). Returns the parsed
 * descriptor `{ type, props }` on a 200, or null on any non-200 (e.g. 404 when the module is disabled).
 * This is the END of the install→enable→slot-resolve→storefront-render pipeline: a 200 `review-list`
 * descriptor means the enabled module is serving the storefront's slot fetch.
 */
export async function fetchReviewsSlotDescriptor(
  productId: string,
): Promise<{ type?: string; props?: { items?: unknown[] } } | null> {
  const ctx = await playwrightRequest.newContext({ baseURL: API_BASE_URL });
  try {
    const url =
      `/store/v1/modules/${encodeURIComponent(REVIEWS_MODULE)}/slot` +
      `?slot=${encodeURIComponent(REVIEWS_SLOT)}&route=${encodeURIComponent(productId)}`;
    const res = await ctx.get(url);
    if (res.status() !== 200) return null;
    return (await res.json()) as { type?: string; props?: { items?: unknown[] } };
  } catch {
    return null;
  } finally {
    await ctx.dispose();
  }
}
