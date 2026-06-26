import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  index,
  unique,
  foreignKey,
} from 'drizzle-orm/pg-core';
import { uuidv7 } from 'uuidv7';
import { tenants } from './_tenants';
import { products } from './products';
import { productVariants } from './product_variants';
import { images } from './images';

/**
 * Product ⇄ image attachment. No `updated_at` (append-style).
 *
 * This was reworked from a derivative-record table
 * into a thin JOIN table between `products` and the generic `images` table (1.5):
 *
 *   - `image_id` is a COMPOSITE FK `(image_id, tenant_id) -> images(id, tenant_id)`
 *     CASCADE — detaching follows the image's lifecycle and can never straddle
 *     tenants. (Replaces the old misuse of `storage_key` as a bare UUID with no FK.)
 *   - `UNIQUE(product_id, image_id)` dedupes re-attaches (idempotent attach / 409).
 *   - The old `variants` jsonb column was dead (it duplicated `images.variants`) and
 *     `storage_key` (a path column) held the image UUID — both were dropped.
 *
 * COMPOSITE FKs: `(product_id, tenant_id) -> products` CASCADE; `(variant_id, tenant_id)
 * -> product_variants` CASCADE. `variant_id` is nullable (product-level images leave it
 * NULL). Note: a composite FK with ON DELETE SET NULL nulls *all* its
 * columns, which would violate `tenant_id NOT NULL` — so variant-specific images CASCADE
 * with their variant.
 */
export const productImages = pgTable(
  'product_images',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    productId: uuid('product_id').notNull(),
    variantId: uuid('variant_id'),
    imageId: uuid('image_id').notNull(),
    altText: text('alt_text'),
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    productFk: foreignKey({
      columns: [t.productId, t.tenantId],
      foreignColumns: [products.id, products.tenantId],
      name: 'product_images_product_fk',
    }).onDelete('cascade'),
    variantFk: foreignKey({
      columns: [t.variantId, t.tenantId],
      foreignColumns: [productVariants.id, productVariants.tenantId],
      name: 'product_images_variant_fk',
    }).onDelete('cascade'),
    imageFk: foreignKey({
      columns: [t.imageId, t.tenantId],
      foreignColumns: [images.id, images.tenantId],
      name: 'product_images_image_fk',
    }).onDelete('cascade'),
    productImageUq: unique('product_images_product_image_uq').on(t.productId, t.imageId),
    productIdx: index('product_images_product_idx').on(t.productId),
    variantIdx: index('product_images_variant_idx').on(t.variantId),
    tenantIdx: index('product_images_tenant_idx').on(t.tenantId),
  }),
);

export type ProductImage = typeof productImages.$inferSelect;
export type NewProductImage = typeof productImages.$inferInsert;
