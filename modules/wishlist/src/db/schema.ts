/**
 * wishlist — module schema (DDL/migration source, NOT a runtime DB handle).
 *
 * `createNamespacedTable(name, suffix)` enforces the hard rule that a module's tables
 * are namespaced `mod_<name>_*` and never touch core tables. It returns a table NAME used in the
 * migration DDL and in `sdk.tables.query/exec` — it does NOT hand back a live query builder. Both
 * names below are also declared in `sovecom.module.json`'s `tables` array so the manifest verifier
 * accepts them.
 */
import { createNamespacedTable } from '@sovecom/module-sdk';

/**
 * `mod_wishlist_items` — one row per (customer, product variant) the customer has wishlisted.
 * UNIQUE(customer_id, product_variant_id) makes "add" idempotent and caps duplicates at the DB.
 */
export const ITEMS_TABLE = createNamespacedTable('wishlist', 'items');

/**
 * `mod_wishlist_digest_log` — idempotency ledger for the weekly price-drop digest. One row per
 * (customer, product_variant, digest_run) we have emailed about, so re-running the same digest (or
 * a retried/duplicate trigger) never emails the same customer about the same drop twice.
 */
export const DIGEST_LOG_TABLE = createNamespacedTable('wishlist', 'digest_log');

/**
 * The idempotent migration DDL for this module's tables. Run once at activate() via
 * `sdk.tables.exec` (each statement is its own call). `CREATE TABLE IF NOT EXISTS` keeps activate()
 * safe to run on every worker start. The module owns its schema (the executor runs these under the
 * module's low-privilege DB role), so plain unqualified table names resolve to the module schema.
 *
 * Returned as an ordered list so both the runtime activate() and the migration tests drive the
 * exact same statements.
 */
export const MIGRATION_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS ${ITEMS_TABLE} (
     id text PRIMARY KEY,
     customer_id text NOT NULL,
     product_variant_id text NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now(),
     UNIQUE (customer_id, product_variant_id)
   )`,
  `CREATE INDEX IF NOT EXISTS mod_wishlist_items_customer_idx
     ON ${ITEMS_TABLE} (customer_id)`,
  `CREATE TABLE IF NOT EXISTS ${DIGEST_LOG_TABLE} (
     id text PRIMARY KEY,
     customer_id text NOT NULL,
     product_variant_id text NOT NULL,
     digest_run_id text NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now(),
     UNIQUE (customer_id, product_variant_id, digest_run_id)
   )`,
];
