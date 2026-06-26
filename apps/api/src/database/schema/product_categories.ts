import { pgTable, uuid, index, primaryKey, foreignKey } from 'drizzle-orm/pg-core';
import { tenants } from './_tenants';
import { products } from './products';
import { categories } from './categories';

/**
 * Product <-> category M2M junction. No `id`, no timestamps.
 *
 * Composite PK `(tenant_id, product_id, category_id)`; both FKs are COMPOSITE to
 * `products(id, tenant_id)` and `categories(id, tenant_id)`, all CASCADE — a link
 * cannot straddle tenants and is removed when either side is deleted.
 */
export const productCategories = pgTable(
  'product_categories',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    productId: uuid('product_id').notNull(),
    categoryId: uuid('category_id').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.tenantId, t.productId, t.categoryId] }),
    productFk: foreignKey({
      columns: [t.productId, t.tenantId],
      foreignColumns: [products.id, products.tenantId],
      name: 'product_categories_product_fk',
    }).onDelete('cascade'),
    categoryFk: foreignKey({
      columns: [t.categoryId, t.tenantId],
      foreignColumns: [categories.id, categories.tenantId],
      name: 'product_categories_category_fk',
    }).onDelete('cascade'),
    categoryIdx: index('product_categories_category_idx').on(t.categoryId),
  }),
);

export type ProductCategory = typeof productCategories.$inferSelect;
export type NewProductCategory = typeof productCategories.$inferInsert;
