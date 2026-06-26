import {
  pgTable,
  uuid,
  integer,
  text,
  timestamp,
  index,
  foreignKey,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { tenants } from './_tenants';
import { discounts } from './discounts';
import { orders } from './orders';
import { customers } from './customers';

/**
 * Per-order discount redemption records — drives per-customer / total
 * usage-limit enforcement.
 *
 * Three COMPOSITE FKs: `(discount_id, tenant_id) -> discounts` onDelete **CASCADE** (a
 * usage is an owned child of its discount); `(order_id, tenant_id) -> orders` onDelete
 * **RESTRICT** (legal record); `(customer_id, tenant_id) -> customers` nullable, onDelete
 * **RESTRICT**. `amount` is integer minor units actually discounted.
 *
 * TODO(2.5): the discount CASCADE here means deleting a discount erases its redemption
 * history. The discount-engine service MUST guard against deleting a discount that has
 * any usages (service-layer "RESTRICT-while-used" — refuse delete, archive/deactivate
 * instead). The DB CASCADE stays for the legitimate "purge an unused draft discount" path.
 */
export const discountUsages = pgTable(
  'discount_usages',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    discountId: uuid('discount_id').notNull(),
    orderId: uuid('order_id').notNull(),
    customerId: uuid('customer_id'),
    // Normalized (lowercased) buyer email. For a logged-in customer this mirrors the
    // customer's email; for a GUEST (customer_id NULL) it is the only key that dedups
    // per-customer usage limits — without it a guest could re-redeem a once-per-customer
    // code indefinitely. Nullable for legacy rows / when no email is known.
    email: text('email'),
    amount: integer('amount').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    discountFk: foreignKey({
      columns: [t.discountId, t.tenantId],
      foreignColumns: [discounts.id, discounts.tenantId],
      name: 'discount_usages_discount_fk',
    }).onDelete('cascade'),
    orderFk: foreignKey({
      columns: [t.orderId, t.tenantId],
      foreignColumns: [orders.id, orders.tenantId],
      name: 'discount_usages_order_fk',
    }).onDelete('restrict'),
    customerFk: foreignKey({
      columns: [t.customerId, t.tenantId],
      foreignColumns: [customers.id, customers.tenantId],
      name: 'discount_usages_customer_fk',
    }).onDelete('restrict'),
    discountIdx: index('discount_usages_discount_idx').on(t.discountId),
    // Index the order FK (TR-DATA-008) — supports the orders-RESTRICT lookup.
    orderIdx: index('discount_usages_order_idx').on(t.orderId),
    customerDiscountIdx: index('discount_usages_customer_discount_idx').on(
      t.customerId,
      t.discountId,
    ),
    // Supports the guest per-customer usage lookup keyed on (tenant, discount, lower(email)).
    emailDiscountIdx: index('discount_usages_email_discount_idx').on(
      t.tenantId,
      t.discountId,
      sql`lower(${t.email})`,
    ),
    tenantIdx: index('discount_usages_tenant_idx').on(t.tenantId),
    amountChk: check('discount_usages_amount_chk', sql`${t.amount} >= 0`),
  }),
);

export type DiscountUsage = typeof discountUsages.$inferSelect;
export type NewDiscountUsage = typeof discountUsages.$inferInsert;
