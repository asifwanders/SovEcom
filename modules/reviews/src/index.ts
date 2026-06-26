/**
 * reviews — a SovEcom reference module (AGPL-3.0).
 *
 * Text-only product reviews (v1). A logged-in shopper who PURCHASED a product may leave one rating +
 * text review; reviews are MODERATED (default 'pending') and only 'approved' reviews are public,
 * along with the approved-only average. Admins moderate via the admin surface. It is a worked
 * example of a customer-scoped, purchase-gated, moderated module on the sandboxed runtime — the
 * permissions it declares (and only those) gate every capability; the core broker enforces them.
 *
 * Trust boundary recap:
 *   - Customer identity comes from `req.customer.id` — the CORE-VERIFIED principal the store proxy
 *     sets from a customer JWT it checked itself (3.10-i.5). Never from client input. Anonymous
 *     submit → 401.
 * - PURCHASE GATE: a single seam, `hasPurchased`, decides eligibility. It calls the
 *     gated `read:orders` commerce probe (`sdk.commerce.hasPurchased`, B1) which returns a real
 *     boolean — purchaser → review pending, non-purchaser → 403. See purchase/purchase-gate.ts +
 *     README "Purchase gate".
 *   - Storage is the module's OWN `mod_reviews_*` table via parameterized `sdk.tables` SQL, run
 *     under the module's low-privilege DB role — the module can never touch a core table. Moderation
 *     (approved-only public reads + averages) is enforced in SQL.
 *   - Admin moderation endpoints are reachable ONLY on the admin surface (admin JWT + `modules:use`,
 *     enforced by the core proxy mount); the same paths on the public store surface are 404.
 */
import { defineModule } from '@sovecom/module-sdk';
import { MIGRATION_STATEMENTS } from './db/schema';
import { ReviewsRepository } from './db/repository';
import { resolveSettings } from './settings';
import { handleRequest } from './api/handlers';

export default defineModule({
  async activate(sdk) {
    // TODO(settings-wiring): the admin-configured settings bag is not yet threaded into
    // activate(sdk) by the runtime — that injection point is not yet wired (see README
    // "Settings wiring"). Until then resolveSettings(undefined) yields safe defaults (enabled,
    // minTextLen=10, maxTextLen=2000, autoApprove off → reviews are moderated). When the runtime
    // exposes the bag, pass it at this single call site — nothing else needs to change.
    const settings = resolveSettings(undefined);

    // Migration: create the module's own table (idempotent). One exec per statement.
    for (const sql of MIGRATION_STATEMENTS) {
      await sdk.tables.exec(sql);
    }

    const repo = new ReviewsRepository(sdk.tables);

    // Mount the HTTP handler. Core proxies /store/v1/modules/reviews/* (public) and
    // /admin/v1/modules/reviews/* (admin-gated) here; the handler branches on req.surface.
    // `sdk.commerce` is the gated read:orders boolean purchase probe the gate uses (B1; see
    // purchase/purchase-gate.ts) — a real purchaser → pending, a non-purchaser → 403.
    sdk.serve((req) =>
      handleRequest(req, {
        repo,
        products: sdk.store.products,
        commerce: sdk.commerce,
        settings,
      }),
    );
  },
});

export { resolveSettings } from './settings';
export type { ReviewsSettings } from './settings';
export { ReviewsRepository } from './db/repository';
export type { ReviewRow, ReviewStatus, PublicReview, ReviewSummary } from './db/repository';
export { handleRequest } from './api/handlers';
export type { HandlerDeps } from './api/handlers';
export {
  handleReviewsSlot,
  buildReviewListDescriptor,
  REVIEWS_SLOT,
  REVIEW_LIST_MAX_ITEMS,
  REVIEW_BODY_MAX_LEN,
} from './slot/reviews-slot';
export {
  hasPurchased,
  commercePurchaseVerifier,
  denyUnverifiablePurchaseVerifier,
} from './purchase/purchase-gate';
export type { PurchaseVerifier } from './purchase/purchase-gate';
