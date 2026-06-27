/**
 * recently-viewed — a SovEcom reference module (AGPL-3.0).
 *
 * Tracks the products a shopper has looked at and surfaces their most-recently-viewed ones (a
 * "Recently viewed" rail). It is a worked example of a per-VIEWER-scoped, low-sensitivity module on
 * the sandboxed runtime — the permissions it declares (and only those) gate every capability; the
 * core broker enforces them.
 *
 * Trust boundary recap:
 *   - The VIEWER identity comes from {@link resolveViewer}: the CORE-VERIFIED `req.customer.id` for a
 *     logged-in shopper, else the CORE-DERIVED `req.guestId.id` from the signed sov_guest httpOnly
 *     cookie. Neither is ever read from client input. When a guest logs in, `POST /merge-guest`
 *     migrates the guest's history to the customer key space.
 *   - Storage is the module's OWN `mod_recently-viewed_views` table via parameterized `sdk.tables`
 *     SQL, run under the module's low-privilege DB role — it can never touch a core table. Every
 *     read/write binds `viewer_key`, so per-viewer isolation is enforced in SQL.
 *   - The catalog read (`read:products`) ENRICHES the list (title/slug/status) and now carries the
 *     product's PRIMARY category (`ModuleProductDto.category`) — still no price. `excludeCategories`
 *     is applied behind a documented resolver SEAM wired to that catalog read (see README "Category
 *     exclusion"). No email, no orders, no events: the module declares none of them.
 *   - There is NO admin surface — the feature is entirely store-facing.
 */
import { defineModule } from '@sovecom/module-sdk';
import { MIGRATION_STATEMENTS } from './db/schema';
import { RecentlyViewedRepository } from './db/repository';
import { resolveSettings } from './settings';
import { handleRequest } from './api/handlers';
import { storeProductCategoryResolver } from './category/category-filter';

export default defineModule({
  async activate(sdk) {
    // TODO(settings-wiring): the admin-configured settings bag is not yet threaded into
    // activate(sdk) by the runtime — that injection point is not yet wired (see README
    // "Settings wiring"). Until then resolveSettings(undefined) yields safe defaults (enabled,
    // maxItems=8, no excluded categories). When the runtime exposes the bag, pass it at this single
    // call site — nothing else needs to change.
    const settings = resolveSettings(undefined);

    // Migration: create the module's own table (idempotent). One exec per statement.
    for (const sql of MIGRATION_STATEMENTS) {
      await sdk.tables.exec(sql);
    }

    const repo = new RecentlyViewedRepository(sdk.tables);

    // Mount the HTTP handler. Core proxies /store/v1/modules/recently-viewed/* here.
    // The category resolver reads the product's primary category from the gated read:products
    // surface (ModuleProductDto.category, B1) — see category/category-filter.ts. Still injectable so
    // tests can stub it.
    sdk.serve((req) =>
      handleRequest(req, {
        repo,
        products: sdk.store.products,
        categoryResolver: storeProductCategoryResolver(sdk.store.products),
        settings,
      }),
    );
  },
});

export { resolveSettings } from './settings';
export type { RecentlyViewedSettings } from './settings';
export { RecentlyViewedRepository } from './db/repository';
export type { ViewRow } from './db/repository';
export { handleRequest } from './api/handlers';
export type { HandlerDeps } from './api/handlers';
export {
  handleRecentlyViewedSlot,
  buildCarouselItems,
  RECENTLY_VIEWED_SLOT,
  CAROUSEL_MAX_ITEMS,
} from './slot/recently-viewed-slot';
export { resolveViewer, CUSTOMER_KEY_PREFIX, GUEST_KEY_PREFIX } from './identity/viewer';
export type { Viewer } from './identity/viewer';
export {
  isExcludedByCategory,
  excludeNothingResolver,
  storeProductCategoryResolver,
} from './category/category-filter';
export type { ProductCategoryResolver } from './category/category-filter';
