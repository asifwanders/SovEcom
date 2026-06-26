import { pgTable, uuid, text, timestamp, index, unique } from 'drizzle-orm/pg-core';
import { uuidv7 } from 'uuidv7';
import { tenants } from './_tenants';

/**
 * Product tags. No `updated_at`.
 *
 * Parent of `product_tags`, so it declares `UNIQUE(id, tenant_id)` to anchor the
 * composite junction FK. Slug is unique per tenant.
 */
export const tags = pgTable(
  'tags',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idTenantUq: unique('tags_id_tenant_uq').on(t.id, t.tenantId),
    slugUq: unique('tags_tenant_slug_uq').on(t.tenantId, t.slug),
    tenantIdx: index('tags_tenant_idx').on(t.tenantId),
  }),
);

export type Tag = typeof tags.$inferSelect;
export type NewTag = typeof tags.$inferInsert;
