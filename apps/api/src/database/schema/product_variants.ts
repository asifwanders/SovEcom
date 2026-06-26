import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  index,
  unique,
  foreignKey,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { tenants } from './_tenants';
import { products } from './products';

/**
 * Per-variant SKU / price / stock.
 *
 * Money = integer minor units (`price_amount`, `compare_at_amount`) + `currency`
 * TEXT NOT NULL with a `char_length = 3` CHECK — never floats. (text+CHECK,
 * not char(3): char pads short values past the check and errors 22001 on long ones.)
 * `product_id` is a
 * COMPOSITE FK to `products(id, tenant_id)`. Parent of `product_images` and
 * `bundle_items`, so it declares `UNIQUE(id, tenant_id)`.
 */
export const productVariants = pgTable(
  'product_variants',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    productId: uuid('product_id').notNull(),
    sku: text('sku').notNull(),
    title: text('title'),
    options: jsonb('options').notNull(),
    priceAmount: integer('price_amount').notNull(),
    currency: text('currency').notNull(),
    compareAtAmount: integer('compare_at_amount'),
    stockQuantity: integer('stock_quantity').notNull().default(0),
    allowBackorder: boolean('allow_backorder').notNull().default(false),
    weightGrams: integer('weight_grams'),
    lengthMm: integer('length_mm'),
    widthMm: integer('width_mm'),
    heightMm: integer('height_mm'),
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    productFk: foreignKey({
      columns: [t.productId, t.tenantId],
      foreignColumns: [products.id, products.tenantId],
      name: 'product_variants_product_fk',
    }).onDelete('cascade'),
    idTenantUq: unique('product_variants_id_tenant_uq').on(t.id, t.tenantId),
    skuUq: unique('product_variants_tenant_sku_uq').on(t.tenantId, t.sku),
    productIdx: index('product_variants_product_idx').on(t.productId),
    tenantIdx: index('product_variants_tenant_idx').on(t.tenantId),
    currencyChk: check('product_variants_currency_chk', sql`char_length(${t.currency}) = 3`),
  }),
);

export type ProductVariant = typeof productVariants.$inferSelect;
export type NewProductVariant = typeof productVariants.$inferInsert;
