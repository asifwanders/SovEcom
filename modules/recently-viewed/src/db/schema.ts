/**
 * recently-viewed — module schema (DDL/migration source, NOT a runtime DB handle).
 *
 * `createNamespacedTable(name, suffix)` enforces the hard rule that a module's tables
 * are namespaced `mod_<name>_*` and never touch core tables. It returns a table NAME used in the
 * migration DDL and in `sdk.tables.query/exec` — it does NOT hand back a live query builder. The
 * name is also declared in `sovecom.module.json`'s `tables` array so the manifest verifier accepts
 * it.
 *
 * IDENTIFIER QUOTING: this module's name (`recently-viewed`) contains a hyphen, so the derived table
 * identifier `mod_recently-viewed_views` is NOT a legal UNQUOTED SQL identifier. We therefore
 * reference it double-quoted everywhere (`TABLE` below). The module's PG schema
 * (`mod_recently-viewed`) is itself double-quoted by the runtime, and the executor pins
 * `search_path` to it — so the unqualified, quoted table name resolves to the module's own schema.
 * Quoting is injection-proof: the module-name slug forbids `"`/whitespace/backslash by construction.
 */
import { createNamespacedTable } from '@sovecom/module-sdk';

/** The bare namespaced identifier (no quotes) — used for the manifest's `tables` declaration. */
export const VIEWS_TABLE_NAME = createNamespacedTable('recently-viewed', 'views');

/**
 * The DOUBLE-QUOTED form used in DDL + parameterized SQL. The hyphenated module name makes the bare
 * identifier illegal unquoted; the slug regex guarantees there is no `"` to escape, so this is a
 * plain wrap.
 */
export const TABLE = `"${VIEWS_TABLE_NAME}"`;

/**
 * `mod_recently-viewed_views` — one row per (viewer, product) that the viewer has looked at.
 *
 * `viewer_key` is the OPAQUE per-viewer key: the core-verified customer id for a logged-in shopper
 * (prefixed `cust:`), or the core-derived guest id from the sov_guest httpOnly cookie for an
 * anonymous one (prefixed `guest:`) — see identity/. It is the ONLY scoping key — a read or write
 * is always bound to one `viewer_key`, so one viewer can never see another's history.
 * UNIQUE(viewer_key, product_id) means a re-view of the same product is a dedupe that bumps
 * `viewed_at` (never a second row).
 *
 * ID TYPES — DELIBERATE: `id` is a module-generated `text` PK (a UUID string); `viewer_key` and
 * `product_id` are `text` because a module receives core ids (and the storefront guest token) as
 * OPAQUE strings — it never parses or assumes their format. The `(viewer_key, viewed_at DESC)` index
 * backs the per-viewer newest-first read.
 */
export const MIGRATION_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS ${TABLE} (
     id text PRIMARY KEY,
     viewer_key text NOT NULL,
     product_id text NOT NULL,
     viewed_at timestamptz NOT NULL DEFAULT now(),
     UNIQUE (viewer_key, product_id)
   )`,
  `CREATE INDEX IF NOT EXISTS mod_recently_viewed_views_viewer_recent_idx
     ON ${TABLE} (viewer_key, viewed_at DESC)`,
];
