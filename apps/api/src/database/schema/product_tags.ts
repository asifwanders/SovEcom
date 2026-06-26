import { pgTable, uuid, index, primaryKey, foreignKey } from 'drizzle-orm/pg-core';
import { tenants } from './_tenants';
import { products } from './products';
import { tags } from './tags';

/**
 * Product <-> tag M2M junction. No `id`, no timestamps.
 *
 * Composite PK `(tenant_id, product_id, tag_id)`; both FKs are COMPOSITE to
 * `products(id, tenant_id)` and `tags(id, tenant_id)`, all CASCADE.
 */
export const productTags = pgTable(
  'product_tags',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    productId: uuid('product_id').notNull(),
    tagId: uuid('tag_id').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.tenantId, t.productId, t.tagId] }),
    productFk: foreignKey({
      columns: [t.productId, t.tenantId],
      foreignColumns: [products.id, products.tenantId],
      name: 'product_tags_product_fk',
    }).onDelete('cascade'),
    tagFk: foreignKey({
      columns: [t.tagId, t.tenantId],
      foreignColumns: [tags.id, tags.tenantId],
      name: 'product_tags_tag_fk',
    }).onDelete('cascade'),
    tagIdx: index('product_tags_tag_idx').on(t.tagId),
  }),
);

export type ProductTag = typeof productTags.$inferSelect;
export type NewProductTag = typeof productTags.$inferInsert;
