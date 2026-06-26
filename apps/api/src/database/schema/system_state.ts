import { pgTable, text, jsonb, timestamp } from 'drizzle-orm/pg-core';

/**
 * Global key-value install / system flags.
 *
 * NO `tenant_id` by design — a single global singleton. PK is `key` (not an
 * id+tenant pair). Holds the `default_tenant_id` the seed needs, plus `installed`
 * and `version`. No `id`/`created_at`; keeps `updated_at`.
 */
export const systemState = pgTable('system_state', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export type SystemState = typeof systemState.$inferSelect;
export type NewSystemState = typeof systemState.$inferInsert;
