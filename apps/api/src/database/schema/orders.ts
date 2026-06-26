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
  uniqueIndex,
  foreignKey,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { tenants } from './_tenants';
import { customers } from './customers';
import { orderStatusEnum } from './_enums';

/**
 * Orders — the commercial record. A SOFT-DELETE table (`deleted_at`) per
 * Orders and customers are soft-deleted. `order_number` is a per-tenant
 * human-readable reference that **MAY gap** — it is NOT the DGFIP fiscal
 * number (that is `invoices.invoice_number`, gapless).
 *
 * `customer_id` is a nullable COMPOSITE FK `(customer_id, tenant_id) -> customers`. Its
 * onDelete is **RESTRICT** (NOT cascade): an order is a legal/commercial record and must
 * survive any attempt to remove its customer. Customers are soft-delete-only (RGPD erase
 * scrubs the order address JSONB in place rather than deleting the order),
 * so this RESTRICT should never actually fire in normal flow; it is a backstop against
 * a CASCADE that would destroy fiscal history. (The catalog/identity children CASCADE rule does
 * NOT apply to orders.)
 *
 * Address snapshots (`shipping_address`/`billing_address`) are JSONB PII scrubbed by RGPD
 * erase. Money is integer minor units; `currency` TEXT + char_length=3 CHECK.
 * Parent of `order_items`, `order_status_history`, `invoices`, `payments`, `refunds`,
 * `returns`, `discount_usages` — declares `UNIQUE(id, tenant_id)`.
 */
export const orders = pgTable(
  'orders',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    orderNumber: text('order_number').notNull(),
    // The cart this order was created from. A SOFT reference (no FK:
    // carts are ephemeral / Redis-first and get cleaned up, an order must outlive its cart) used
    // by the payment-intent endpoint's idempotent load-or-create: a retried PI request on an
    // already-`converted` cart finds THIS order instead of erroring. Nullable for orders made
    // by other future paths. Indexed for the lookup.
    cartId: uuid('cart_id'),
    customerId: uuid('customer_id'),
    email: text('email').notNull(),
    status: orderStatusEnum('status').notNull().default('pending_payment'),
    currency: text('currency').notNull(),
    subtotalAmount: integer('subtotal_amount').notNull(),
    discountAmount: integer('discount_amount').notNull().default(0),
    shippingAmount: integer('shipping_amount').notNull().default(0),
    taxAmount: integer('tax_amount').notNull().default(0),
    totalAmount: integer('total_amount').notNull(),
    refundedAmount: integer('refunded_amount').notNull().default(0),
    isB2b: boolean('is_b2b').notNull().default(false),
    vatNumber: text('vat_number'),
    reverseCharge: boolean('reverse_charge').notNull().default(false),
    // VIES consultation reference snapshotted at order time.
    // Copied from the customer's live `valid` B2B proof (customers.metadata.vat.consultationRef,
    // so the invoice's reverse-charge evidence is stable — the
    // invoice reads this column, never the now-mutable customer. Null for B2C / no-VAT / cached.
    viesConsultationRef: text('vies_consultation_ref'),
    // Fulfillment freeze: set true on `charge.dispute.created`.
    // OrderService.transition refuses `→ fulfilled` / `→ shipped` while frozen so a disputed
    // order cannot ship. Cleared by admin/dispute resolution.
    fulfillmentFrozen: boolean('fulfillment_frozen').notNull().default(false),
    taxInclusive: boolean('tax_inclusive').notNull(),
    shippingAddress: jsonb('shipping_address').notNull(),
    billingAddress: jsonb('billing_address').notNull(),
    shippingMethod: text('shipping_method'),
    trackingNumber: text('tracking_number'),
    carrier: text('carrier'),
    discountCode: text('discount_code'),
    notes: text('notes'),
    // Guest order-lookup access token: the sha256 HASH of a per-order
    // token. The plaintext is returned ONCE at creation and never stored; the public by-number
    // lookup constant-time-compares sha256(provided) to this. Never logged.
    guestTokenHash: text('guest_token_hash'),
    metadata: jsonb('metadata').notNull().default({}),
    placedAt: timestamp('placed_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    customerFk: foreignKey({
      columns: [t.customerId, t.tenantId],
      foreignColumns: [customers.id, customers.tenantId],
      name: 'orders_customer_fk',
    }).onDelete('restrict'),
    idTenantUq: unique('orders_id_tenant_uq').on(t.id, t.tenantId),
    orderNumberUq: uniqueIndex('orders_tenant_order_number_uq').on(t.tenantId, t.orderNumber),
    tenantStatusIdx: index('orders_tenant_status_idx').on(t.tenantId, t.status),
    customerIdx: index('orders_customer_idx').on(t.customerId),
    // Idempotent load-or-create lookup (payment-intent on a converted cart).
    cartIdx: index('orders_tenant_cart_idx').on(t.tenantId, t.cartId),
    tenantCreatedIdx: index('orders_tenant_created_idx').on(t.tenantId, t.createdAt),
    currencyChk: check('orders_currency_chk', sql`char_length(${t.currency}) = 3`),
    // Non-negative money invariants (money = integer minor units, never negative).
    amountsChk: check(
      'orders_amounts_nonneg_chk',
      sql`${t.subtotalAmount} >= 0 and ${t.discountAmount} >= 0 and ${t.shippingAmount} >= 0 and ${t.taxAmount} >= 0 and ${t.totalAmount} >= 0 and ${t.refundedAmount} >= 0`,
    ),
  }),
);

export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;
