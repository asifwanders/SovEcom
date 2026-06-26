/**
 * reviews — module schema (DDL/migration source, NOT a runtime DB handle).
 *
 * `createNamespacedTable(name, suffix)` enforces the hard rule that a module's tables
 * are namespaced `mod_<name>_*` and never touch core tables. It returns a table NAME used in the
 * migration DDL and in `sdk.tables.query/exec` — it does NOT hand back a live query builder. The
 * name below is also declared in `sovecom.module.json`'s `tables` array so the manifest verifier
 * accepts it. `reviews` is a clean slug, so the resulting `mod_reviews_reviews` is a legal unquoted
 * SQL identifier (no double-quoting needed).
 */
import { createNamespacedTable } from '@sovecom/module-sdk';

/**
 * `mod_reviews_reviews` — one row per (customer, product) review.
 *
 * UNIQUE(customer_id, product_id) enforces one review per customer per product (a repeat POST is a
 * 409, never a second row). `status` is the moderation state: 'pending' (default) is hidden from the
 * public read; only 'approved' rows surface and feed the average; 'rejected' is hidden too.
 */
export const REVIEWS_TABLE = createNamespacedTable('reviews', 'reviews');

/**
 * The idempotent migration DDL for this module's table. Run once at activate() via `sdk.tables.exec`
 * (each statement is its own call). `CREATE TABLE IF NOT EXISTS` keeps activate() safe to run on
 * every worker start. The module owns its schema (the executor runs these under the module's
 * low-privilege DB role), so plain unqualified table names resolve to the module schema.
 *
 * `rating` is constrained to [1,5] at the DB as defense-in-depth behind the handler's validation;
 * `status` is constrained to the three legal moderation values. Returned as an ordered list so both
 * the runtime activate() and the migration tests drive the exact same statements.
 *
 * ID TYPES — DELIBERATE: `id` is a module-generated `text` PK (a UUID string), and `customer_id` /
 * `product_id` are `text` because a module receives core ids as OPAQUE strings (via `req.customer.id`
 * and the request body) — it never parses or assumes core's id format. This is intentional, NOT an
 * accidental deviation from core's internal uuidv7 convention: a module accepts whatever id format
 * core hands it without coupling to it.
 */
export const MIGRATION_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS ${REVIEWS_TABLE} (
     id text PRIMARY KEY,
     customer_id text NOT NULL,
     product_id text NOT NULL,
     rating smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
     body text NOT NULL,
     status text NOT NULL DEFAULT 'pending'
       CHECK (status IN ('pending', 'approved', 'rejected')),
     created_at timestamptz NOT NULL DEFAULT now(),
     UNIQUE (customer_id, product_id)
   )`,
  `CREATE INDEX IF NOT EXISTS mod_reviews_reviews_product_status_idx
     ON ${REVIEWS_TABLE} (product_id, status)`,
];
