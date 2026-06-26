import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  vector,
  index,
  unique,
  foreignKey,
} from 'drizzle-orm/pg-core';
import { uuidv7 } from 'uuidv7';
import { tenants } from './_tenants';

/**
 * Hierarchical categories.
 *
 * `parent_id` is a self-referential COMPOSITE FK `(parent_id, tenant_id) ->
 * categories(id, tenant_id)` CASCADE — a subtree is deleted with its root, and a
 * child can never point at a parent in another tenant. Parent
 * of `product_categories`, so it declares `UNIQUE(id, tenant_id)`.
 */
export const categories = pgTable(
  'categories',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    parentId: uuid('parent_id'),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    description: text('description'),
    seoTitle: text('seo_title'),
    seoDescription: text('seo_description'),
    position: integer('position').notNull().default(0),
    embedding: vector('embedding', { dimensions: 1536 }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    parentFk: foreignKey({
      columns: [t.parentId, t.tenantId],
      foreignColumns: [t.id, t.tenantId],
      name: 'categories_parent_fk',
    }).onDelete('cascade'),
    idTenantUq: unique('categories_id_tenant_uq').on(t.id, t.tenantId),
    slugUq: unique('categories_tenant_slug_uq').on(t.tenantId, t.slug),
    parentIdx: index('categories_parent_idx').on(t.parentId),
    tenantIdx: index('categories_tenant_idx').on(t.tenantId),
  }),
);

export type Category = typeof categories.$inferSelect;
export type NewCategory = typeof categories.$inferInsert;
