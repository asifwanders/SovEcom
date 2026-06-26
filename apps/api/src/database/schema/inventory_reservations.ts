import { pgTable, uuid, integer, timestamp, index, foreignKey, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { tenants } from './_tenants';
import { carts } from './carts';
import { productVariants } from './product_variants';
import { reservationStatusEnum } from './_enums';

/**
 * Stock reserved by an active cart (FR-CART-003, TR-REL-001).
 *
 * Reservation correctness is enforced by a Postgres `SELECT … FOR UPDATE` row lock on
 * the variant; the doc-23 "Redis-mirrored atomic decrement" is a
 * deferred future optimisation, NOT the current engine. Two COMPOSITE FKs:
 * `(variant_id, tenant_id)` and
 * `(cart_id, tenant_id)` — both NOT NULL (cart_id is NOT NULL).
 *
 * onDelete: cart CASCADE (a reservation is meaningless without its cart); variant
 * CASCADE. The partial index on `expires_at WHERE status='reserved'` powers the sweeper.
 */
export const inventoryReservations = pgTable(
  'inventory_reservations',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    variantId: uuid('variant_id').notNull(),
    cartId: uuid('cart_id').notNull(),
    quantity: integer('quantity').notNull(),
    status: reservationStatusEnum('status').notNull().default('reserved'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    variantFk: foreignKey({
      columns: [t.variantId, t.tenantId],
      foreignColumns: [productVariants.id, productVariants.tenantId],
      name: 'inventory_reservations_variant_fk',
    }).onDelete('cascade'),
    cartFk: foreignKey({
      columns: [t.cartId, t.tenantId],
      foreignColumns: [carts.id, carts.tenantId],
      name: 'inventory_reservations_cart_fk',
    }).onDelete('cascade'),
    variantStatusIdx: index('inventory_reservations_variant_status_idx').on(t.variantId, t.status),
    cartIdx: index('inventory_reservations_cart_idx').on(t.cartId),
    tenantIdx: index('inventory_reservations_tenant_idx').on(t.tenantId),
    reservedExpiresIdx: index('inventory_reservations_reserved_expires_idx')
      .on(t.expiresAt)
      .where(sql`status = 'reserved'`),
    quantityChk: check('inventory_reservations_quantity_chk', sql`${t.quantity} > 0`),
  }),
);

export type InventoryReservation = typeof inventoryReservations.$inferSelect;
export type NewInventoryReservation = typeof inventoryReservations.$inferInsert;
