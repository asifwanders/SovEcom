/**
 * notify-back-in-stock — a SovEcom reference module (AGPL-3.0).
 *
 * A guest-friendly back-in-stock notifier: a shopper (logged in or not) asks to be emailed when an
 * out-of-stock product variant is available again. It is a worked example of an EMAIL-keyed,
 * anonymous-capable module on the sandboxed runtime — the permissions it declares (and only those)
 * gate every capability; the core broker enforces them.
 *
 * Trust boundary recap:
 * - The subscription is EMAIL-keyed. Subscribe does NOT require login — the shopper
 *     supplies their own email, validated with the SAME header-injection-safe rule the email port
 *     uses before it is stored. When `req.customer` is present (the 3.10-i.5 core-verified bridge)
 *     its id is recorded alongside, but it is never the key and never trusted from the body.
 *   - Storage is the module's OWN `mod_notify-back-in-stock_*` table via parameterized `sdk.tables`
 *     SQL, run under the module's low-privilege DB role — the module can never touch a core table.
 *   - Email goes through `sdk.email.send` (core validates, rate-limits, audits, and supplies the
 *     transport — the module never sees SMTP creds).
 *
 * Restock detection is NOT automatic (a runtime gap — see README "Restock wiring"): there is no
 * stock event a module may subscribe to and no stock level on the read DTO, so the actual send is a
 * DIRECTLY-INVOKABLE runner (`runBackInStockNotifications`) a scheduled trigger / admin job supplies
 * the restocked variant ids to. The module subscribes to `product.updated` only to be wired to learn
 * a product changed.
 */
import { defineModule } from '@sovecom/module-sdk';
import { MIGRATION_STATEMENTS } from './db/schema';
import { NotifyRepository } from './db/repository';
import { resolveSettings } from './settings';
import { handleRequest } from './api/handlers';
import { registerSubscriptions } from './events/subscriptions';

export default defineModule({
  async activate(sdk) {
    // TODO(settings-wiring): the admin-configured settings bag is not yet threaded into
    // activate(sdk) by the runtime — that injection point is not yet wired (see README
    // "Settings wiring"). Until then resolveSettings(undefined) yields safe defaults (enabled,
    // batchSize=500, default subject template). When the runtime exposes the bag, pass it at this
    // single call site — nothing else needs to change.
    const settings = resolveSettings(undefined);

    // Migration: create the module's own table (idempotent). One exec per statement.
    for (const sql of MIGRATION_STATEMENTS) {
      await sdk.tables.exec(sql);
    }

    const repo = new NotifyRepository(sdk.tables);

    // B2 — the restock notifier is now EVENT-DRIVEN: subscribe to the observational
    // `product.stock_changed` and, when a variant flips back to AVAILABLE (`available === true`),
    // run the existing idempotent notifier for that variant's subscribers via `sdk.email.send`. The
    // payload is a back-in-stock BOOLEAN only — core never exposes the stock level to the module.
    // `markNotified` (NULL → now()) keeps a redelivered stock event from re-emailing a subscriber.
    await registerSubscriptions(sdk.events, {
      restock: { notify: { repo, store: sdk.store, email: sdk.email, settings } },
    });

    // Mount the HTTP handler. Core proxies /store/v1/modules/notify-back-in-stock/* here.
    sdk.serve((req) => handleRequest(req, { repo, settings }));
  },
});

// Re-export the runner so a scheduled trigger / admin job / test can invoke it directly (the runtime
// has no stock event to drive it automatically — see README "Restock wiring").
export { runBackInStockNotifications, renderSubject, renderText } from './notify/notify';
export type { RunInput, RunResult } from './notify/notify';
export { resolveSettings } from './settings';
export type { NotifySettings } from './settings';
export { NotifyRepository } from './db/repository';
export { handleNotifySlot, NOTIFY_SLOT } from './slot/notify-slot';
export { handleRequest } from './api/handlers';
export type { HandlerDeps } from './api/handlers';
