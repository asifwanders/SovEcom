import { pgTable, text, timestamp, primaryKey } from 'drizzle-orm/pg-core';

/**
 * Module migration ledger. CORE-owned — written ONLY by the app
 * role, NEVER the module role — so a module cannot forge/drop its own migration history to replay
 * or skip migrations (3.3d A+B review HIGH). Keyed by `(module, migration_id)`.
 *
 * NOT tenant-scoped: a module's schema `mod_<name>` is shared across tenants in v1 (the on-disk +
 * DB module home is per-name, not per-tenant — multi-tenant support is a future follow-up.
 */
export const moduleMigrations = pgTable(
  'module_migrations',
  {
    module: text('module').notNull(),
    migrationId: text('migration_id').notNull(),
    checksum: text('checksum').notNull(),
    appliedAt: timestamp('applied_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.module, t.migrationId] }),
  }),
);

export type ModuleMigrationRow = typeof moduleMigrations.$inferSelect;
