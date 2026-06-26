/**
 * wishlist — a SovEcom reference module (AGPL-3.0).
 *
 * A per-customer wishlist: a logged-in shopper adds product variants to a personal list, views it,
 * and removes from it; an opt-in weekly digest emails them when a wishlisted item's price drops.
 * It is a worked example of a customer-scoped module on the sandboxed runtime — the permissions it
 * declares (and only those) gate every capability; the core broker enforces them.
 *
 * Trust boundary recap:
 *   - Customer identity comes from `req.customer.id` — the CORE-VERIFIED principal the store proxy
 *     sets from a customer JWT it checked itself (3.10-i.5). Never from client input. Anonymous
 *     calls to a personal-data route get 401.
 *   - Storage is the module's OWN `mod_wishlist_*` tables via parameterized `sdk.tables` SQL, run
 *     under the module's low-privilege DB role. Every statement binds `customer_id`, so customers
 *     are isolated from each other and the module can never touch a core table.
 *   - Email goes through `sdk.email.sendToCustomer` (B3): the module names a customer by id; CORE
 *     resolves the recipient, honours marketing consent + RGPD erasure, validates, rate-limits,
 *     audits, and supplies the transport — the module never sees the email or SMTP creds.
 */
import { defineModule } from '@sovecom/module-sdk';
import { MIGRATION_STATEMENTS } from './db/schema';
import { WishlistRepository } from './db/repository';
import { resolveSettings } from './settings';
import { handleRequest } from './api/handlers';
import { registerSubscriptions } from './events/subscriptions';

export default defineModule({
  async activate(sdk) {
    // TODO(settings-wiring): the admin-configured settings bag is not yet threaded into
    // activate(sdk) by the runtime — that injection point is not yet wired (see README
    // "Settings wiring"). Until then resolveSettings(undefined) yields safe defaults (enabled,
    // maxItemsPerCustomer=100, weeklyDigest off). When the runtime exposes the bag, pass it at this
    // single call site — nothing else needs to change.
    const settings = resolveSettings(undefined);

    // Migration: create the module's own tables (idempotent). One exec per statement.
    for (const sql of MIGRATION_STATEMENTS) {
      await sdk.tables.exec(sql);
    }

    const repo = new WishlistRepository(sdk.tables);

    // B2/B3 — the price-drop digest is EVENT-DRIVEN: subscribe to the observational
    // `product.price_changed` and run the idempotent digest on a real drop. The digest emails each
    // matched customer via `sdk.email.sendToCustomer` (B3): the module supplies only the customer id;
    // CORE resolves the recipient and honours marketing consent + RGPD erasure. The
    // per-(customer, variant, run) ledger keeps a redelivered event a no-op. The old `resolveEmail`
    // stub is GONE — the email gap is closed by core, not a module-injected resolver.
    await registerSubscriptions(sdk.events, {
      priceDrop: {
        digest: { repo, email: sdk.email, settings },
      },
    });

    // Mount the HTTP handler. Core proxies /store/v1/modules/wishlist/* here.
    sdk.serve((req) => handleRequest(req, { repo, store: sdk.store, settings }));
  },
});

// Re-export the digest entrypoint so a scheduled trigger / admin job / test can invoke it directly
// (the runtime has no price-drop event to drive it automatically — see README "Digest wiring").
export { runPriceDropDigest, buildDigestEmail } from './digest/digest';
export type { PriceDropCandidate, DigestInput, DigestResult } from './digest/digest';
export { resolveSettings } from './settings';
export type { WishlistSettings } from './settings';
export { handleWishlistSlot, WISHLIST_SLOT } from './slot/wishlist-slot';
export { handleRequest } from './api/handlers';
export type { HandlerDeps } from './api/handlers';
