import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
  index,
  unique,
  foreignKey,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { tenants } from './_tenants';
import { carts } from './carts';
import { productVariants } from './product_variants';

/**
 * Line items within a cart.
 *
 * Two COMPOSITE FKs: `(cart_id, tenant_id) -> carts(id, tenant_id)` and
 * `(variant_id, tenant_id) -> product_variants(id, tenant_id)` — neither can straddle
 * tenants. `unit_price_amount` is integer minor units captured at add-time; `currency`
 * TEXT NOT NULL with a `char_length = 3` CHECK. UNIQUE `(cart_id, variant_id)`
 * so a variant appears at most once per cart (quantity merges).
 *
 * onDelete: cart CASCADE (clearing a cart drops its items); variant CASCADE (a cart line
 * for a deleted variant is transient pre-checkout data, NOT a fiscal record — contrast
 * order_items.variant_id which is SET NULL).
 */
export const cartItems = pgTable(
  'cart_items',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    cartId: uuid('cart_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    quantity: integer('quantity').notNull(),
    unitPriceAmount: integer('unit_price_amount').notNull(),
    currency: text('currency').notNull(),
    // Display-identity snapshot captured at add-time. NULLABLE so this is an
    // additive, backfill-safe migration (existing rows keep NULL; the rehydrate read defaults them).
    // Snapshot semantics: stable against a later product/variant rename, unpublish, or delete.
    productTitle: text('product_title'),
    variantTitle: text('variant_title'),
    options: jsonb('options'),
    sku: text('sku'),
    productSlug: text('product_slug'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    cartFk: foreignKey({
      columns: [t.cartId, t.tenantId],
      foreignColumns: [carts.id, carts.tenantId],
      name: 'cart_items_cart_fk',
    }).onDelete('cascade'),
    variantFk: foreignKey({
      columns: [t.variantId, t.tenantId],
      foreignColumns: [productVariants.id, productVariants.tenantId],
      name: 'cart_items_variant_fk',
    }).onDelete('cascade'),
    cartIdx: index('cart_items_cart_idx').on(t.cartId),
    // Index the variant FK (TR-DATA-008) — the (cart_id, variant_id) unique index
    // can't serve a variant_id-leading lookup.
    variantIdx: index('cart_items_variant_idx').on(t.variantId),
    tenantIdx: index('cart_items_tenant_idx').on(t.tenantId),
    cartVariantUq: unique('cart_items_cart_variant_uq').on(t.cartId, t.variantId),
    quantityChk: check('cart_items_quantity_chk', sql`${t.quantity} > 0`),
    priceChk: check('cart_items_unit_price_chk', sql`${t.unitPriceAmount} >= 0`),
    currencyChk: check('cart_items_currency_chk', sql`char_length(${t.currency}) = 3`),
  }),
);

export type CartItem = typeof cartItems.$inferSelect;
export type NewCartItem = typeof cartItems.$inferInsert;
