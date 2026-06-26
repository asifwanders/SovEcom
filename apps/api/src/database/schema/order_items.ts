import {
  pgTable,
  uuid,
  text,
  integer,
  numeric,
  timestamp,
  index,
  unique,
  foreignKey,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { tenants } from './_tenants';
import { orders } from './orders';
import { productVariants } from './product_variants';

/**
 * Order line items — fiscal record lines.
 *
 * ⚠️ LEGAL LANDMINE: `variant_id` is **ON DELETE SET NULL**, NEVER CASCADE. Hard-deleting a
 * sold product/variant must leave the invoice line intact (DGFIP / French invoice-retention law)
 * — the snapshot columns `product_title`, `sku`, `unit_price_amount`, `tax_rate` (all NOT NULL)
 * preserve the line after the variant is gone.
 *
 * SUBTLETY: `variant_id` is a COMPOSITE FK `(variant_id, tenant_id) -> product_variants`.
 * A plain composite SET NULL would also null `tenant_id` (NOT NULL → constraint error).
 * The generated migration is HAND-EDITED to Postgres 17's column-specific form
 * `ON DELETE SET NULL (variant_id)` so ONLY `variant_id` is nulled and `tenant_id`
 * survives. Drizzle's `.onDelete('set null')` below cannot express the column list, so the
 * migration SQL is the authority for that detail (the snapshot reflects the hand-edit).
 *
 * `order_id` is a COMPOSITE FK with ON DELETE CASCADE (deleting an order is not a normal
 * operation — orders soft-delete — but if a row is ever truly removed its lines go with
 * it). Parent of `refund_line_items`, so it declares `UNIQUE(id, tenant_id)`.
 */
export const orderItems = pgTable(
  'order_items',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    orderId: uuid('order_id').notNull(),
    variantId: uuid('variant_id'),
    productTitle: text('product_title').notNull(),
    variantTitle: text('variant_title'),
    sku: text('sku').notNull(),
    quantity: integer('quantity').notNull(),
    unitPriceAmount: integer('unit_price_amount').notNull(),
    taxRate: numeric('tax_rate', { precision: 5, scale: 4 }).notNull(),
    taxAmount: integer('tax_amount').notNull(),
    lineTotalAmount: integer('line_total_amount').notNull(),
    refundedQuantity: integer('refunded_quantity').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    orderFk: foreignKey({
      columns: [t.orderId, t.tenantId],
      foreignColumns: [orders.id, orders.tenantId],
      name: 'order_items_order_fk',
    }).onDelete('cascade'),
    // ⚠️ SET NULL (column-specific in migration SQL — see file header). NOT cascade.
    variantFk: foreignKey({
      columns: [t.variantId, t.tenantId],
      foreignColumns: [productVariants.id, productVariants.tenantId],
      name: 'order_items_variant_fk',
    }).onDelete('set null'),
    idTenantUq: unique('order_items_id_tenant_uq').on(t.id, t.tenantId),
    orderIdx: index('order_items_order_idx').on(t.orderId),
    // Index the variant FK (TR-DATA-008). LOAD-BEARING: scanned both by the
    // ON DELETE SET NULL on variant delete AND the Phase-2 409-sold-product guard.
    variantIdx: index('order_items_variant_idx').on(t.variantId),
    tenantIdx: index('order_items_tenant_idx').on(t.tenantId),
    quantityChk: check('order_items_quantity_chk', sql`${t.quantity} > 0`),
    // Non-negative money invariants (integer minor units).
    amountsChk: check(
      'order_items_amounts_nonneg_chk',
      sql`${t.unitPriceAmount} >= 0 and ${t.taxAmount} >= 0 and ${t.lineTotalAmount} >= 0`,
    ),
  }),
);

export type OrderItem = typeof orderItems.$inferSelect;
export type NewOrderItem = typeof orderItems.$inferInsert;
