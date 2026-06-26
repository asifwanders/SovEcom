/**
 * `createNamespacedTable`: a DDL/migration AUTHORING helper that enforces the `mod_<name>_`
 * table-name prefix.
 *
 * It returns a namespaced table NAME (a DDL identifier the author uses in their migration source
 * and `db/schema.ts`). It does NOT return a live Drizzle/pg handle or query builder — module
 * own-table access AT RUNTIME is parameterized SQL via `sdk.tables.query/exec` (the broker's
 * gated module-sql executor), the only data path that exists.
 *
 * The prefix rule mirrors `moduleManifestSchema`'s table superRefine: the module name is a
 * lowercase slug, the table suffix is `[a-z0-9_]+`, and the full identifier is
 * `mod_<name>_<suffix>`. This is the SAME shape the manifest's `tables` array must satisfy, so an
 * author can feed these names straight into their manifest and pass verification.
 */
import { MODULE_NAME_RE, TABLE_SUFFIX_RE } from './manifest.js';

/**
 * Build the namespaced DDL identifier `mod_<module>_<suffix>` for an author's own table.
 *
 * @param moduleName the module's manifest `name` (lowercase slug, `^[a-z][a-z0-9-]*$`).
 * @param suffix the table's local name within the module (lowercase, `[a-z0-9_]+`).
 * @returns the fully-namespaced table name, e.g. `createNamespacedTable('wishlist', 'items')`
 *          → `'mod_wishlist_items'`.
 * @throws if `moduleName` is not a valid module slug or `suffix` is empty/invalid.
 */
export function createNamespacedTable(moduleName: string, suffix: string): string {
  if (typeof moduleName !== 'string' || !MODULE_NAME_RE.test(moduleName)) {
    throw new Error(
      `createNamespacedTable: module name "${String(moduleName)}" must be a lowercase slug`,
    );
  }
  if (typeof suffix !== 'string' || !TABLE_SUFFIX_RE.test(suffix)) {
    throw new Error(
      `createNamespacedTable: table suffix "${String(suffix)}" must be lowercase [a-z0-9_]`,
    );
  }
  // Defence in depth: reject a suffix that would re-introduce the prefix or escape the namespace.
  if (suffix.startsWith('mod_')) {
    throw new Error(
      `createNamespacedTable: table suffix "${suffix}" must not start with the reserved "mod_" prefix`,
    );
  }
  return `mod_${moduleName}_${suffix}`;
}
