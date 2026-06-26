import { pgTable, uuid, integer, timestamp, index, foreignKey } from 'drizzle-orm/pg-core';
import { uuidv7 } from 'uuidv7';
import { tenants } from './_tenants';
import { products } from './products';
import { productVariants } from './product_variants';

/**
 * Bundle composition for `is_bundle` products. No
 * `updated_at` (id + 4 cols only).
 *
 * Both FKs are COMPOSITE: `(bundle_product_id, tenant_id) -> products` and
 * `(variant_id, tenant_id) -> product_variants`, both CASCADE — deleting either the
 * bundle product or a component variant removes the line.
 */
export const bundleItems = pgTable(
  'bundle_items',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    bundleProductId: uuid('bundle_product_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    quantity: integer('quantity').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    bundleProductFk: foreignKey({
      columns: [t.bundleProductId, t.tenantId],
      foreignColumns: [products.id, products.tenantId],
      name: 'bundle_items_bundle_product_fk',
    }).onDelete('cascade'),
    variantFk: foreignKey({
      columns: [t.variantId, t.tenantId],
      foreignColumns: [productVariants.id, productVariants.tenantId],
      name: 'bundle_items_variant_fk',
    }).onDelete('cascade'),
    bundleProductIdx: index('bundle_items_bundle_product_idx').on(t.bundleProductId),
    variantIdx: index('bundle_items_variant_idx').on(t.variantId),
    tenantIdx: index('bundle_items_tenant_idx').on(t.tenantId),
  }),
);

export type BundleItem = typeof bundleItems.$inferSelect;
export type NewBundleItem = typeof bundleItems.$inferInsert;
