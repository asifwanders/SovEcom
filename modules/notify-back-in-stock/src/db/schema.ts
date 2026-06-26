/**
 * notify-back-in-stock — module schema (DDL/migration source, NOT a runtime DB handle).
 *
 * `createNamespacedTable(name, suffix)` enforces the hard rule that a module's tables
 * are namespaced `mod_<name>_*` and never touch core tables. It returns a table NAME used in the
 * migration DDL and in `sdk.tables.query/exec` — it does NOT hand back a live query builder. The
 * name is also declared in `sovecom.module.json`'s `tables` array so the manifest verifier accepts
 * it.
 *
 * IDENTIFIER QUOTING: this module's name (`notify-back-in-stock`) contains hyphens, so the derived
 * table identifier `mod_notify-back-in-stock_subscriptions` is NOT a legal UNQUOTED SQL identifier.
 * We therefore reference it double-quoted everywhere (`TABLE` below). The module's PG schema
 * (`mod_notify-back-in-stock`) is itself double-quoted by the runtime, and the executor pins
 * `search_path` to it — so the unqualified, quoted table name resolves to the module's own schema.
 * Quoting is injection-proof: the module-name slug forbids `"`/whitespace/backslash by construction.
 */
import { createNamespacedTable } from '@sovecom/module-sdk';

/** The bare namespaced identifier (no quotes) — used for the manifest's `tables` declaration. */
export const SUBSCRIPTIONS_TABLE_NAME = createNamespacedTable(
  'notify-back-in-stock',
  'subscriptions',
);

/**
 * The DOUBLE-QUOTED form used in DDL + parameterized SQL. The hyphenated module name makes the
 * bare identifier illegal unquoted; the slug regex guarantees there is no `"` to escape, so this
 * is a plain wrap.
 */
export const TABLE = `"${SUBSCRIPTIONS_TABLE_NAME}"`;

/**
 * `mod_notify-back-in-stock_subscriptions` — one row per (email, product variant) a shopper has
 * asked to be notified about when it is back in stock. The subscription is email-keyed, not
 * customer-id-keyed, because the endpoint is guest-friendly: a not-logged-in shopper supplies
 * their own email. `customer_id` is recorded opportunistically when a verified customer principal
 * is present, but it is never the key.
 *
 * UNIQUE(customer_email, product_variant_id) dedupes a re-subscribe to the SAME variant — a repeat
 * subscribe is a no-op insert that resets `notified_at` to NULL (so a returning shopper who already
 * got one notification, then re-subscribes, is eligible to be notified again on the NEXT restock).
 *
 * `notified_at` is the idempotency anchor for the restock runner: NULL = not yet notified for the
 * current subscription; a timestamp = already emailed (won't be emailed again until a re-subscribe
 * resets it).
 */
export const MIGRATION_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS ${TABLE} (
     id text PRIMARY KEY,
     customer_email text NOT NULL,
     product_variant_id text NOT NULL,
     customer_id text NULL,
     created_at timestamptz NOT NULL DEFAULT now(),
     notified_at timestamptz NULL,
     UNIQUE (customer_email, product_variant_id)
   )`,
  `CREATE INDEX IF NOT EXISTS mod_notify_back_in_stock_variant_idx
     ON ${TABLE} (product_variant_id)`,
];
