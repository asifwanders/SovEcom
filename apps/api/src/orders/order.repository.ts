/**
 * OrderRepository — tenant-scoped access to orders and order_status_history.
 *
 * Minimal interface mirroring TaxesRepository conventions (DatabaseService injection, every query
 * filters tenant_id). Provides what the state-machine transition needs.
 *
 * Mutating methods take an explicit `tx` so `OrderService.transition` can run the
 * lock + update + history-insert in one transaction. `findByIdForUpdate` issues
 * `SELECT ... FOR UPDATE` so the row is locked for the lifetime of the surrounding
 * transaction (serializes concurrent transitions).
 */
import { Injectable } from '@nestjs/common';
import { and, count, desc, eq, ilike, inArray, isNull, lt, notExists, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { DatabaseService } from '../database/database.service';
import { orders, type Order, type NewOrder } from '../database/schema/orders';
import { orderItems, type NewOrderItem, type OrderItem } from '../database/schema/order_items';
import { orderCounters } from '../database/schema/order_counters';
import { discounts } from '../database/schema/discounts';
import { discountUsages } from '../database/schema/discount_usages';
import { carts } from '../database/schema/carts';
import { payments } from '../database/schema/payments';
import { products } from '../database/schema/products';
import { productVariants } from '../database/schema/product_variants';
import { bundleItems } from '../database/schema/bundle_items';
import {
  orderStatusHistory,
  type OrderStatusHistory,
} from '../database/schema/order_status_history';
import type { OrderStatus } from './order-status';

/** The transaction handle drizzle passes to a `.transaction(async (tx) => …)` callback. */
type Tx = Parameters<Parameters<DatabaseService['db']['transaction']>[0]>[0];

/** Either the base db handle or an open transaction — both expose the query builder. */
type Db = DatabaseService['db'] | Tx;

/** Parameters for an `order_status_history` append. `changedBy`/`note` are optional. */
export interface StatusHistoryInput {
  tenantId: string;
  orderId: string;
  fromStatus: OrderStatus | null;
  toStatus: OrderStatus;
  changedBy?: string | null;
  note?: string | null;
}

/** Offset-pagination filters for the admin order list (mirrors the customer list). */
export interface OrderListFilters {
  page: number;
  pageSize: number;
  q?: string;
  status?: OrderStatus;
  customerId?: string;
}

/** A page of orders + the total row count (mirrors the customer admin list shape). */
export interface OrderListResult {
  data: Order[];
  total: number;
  page: number;
  pageSize: number;
}

@Injectable()
export class OrderRepository {
  constructor(private readonly database: DatabaseService) {}

  /** The base (non-transactional) db handle, for read-only callers. */
  private get db() {
    return this.database.db;
  }

  /**
   * Load an order by id for the tenant, taking a `SELECT … FOR UPDATE` row lock.
   * Excludes soft-deleted orders. Returns null when missing/deleted in this tenant.
   * MUST be called inside a transaction for the lock to be meaningful — pass the `tx`.
   * Tenant-scoped.
   */
  async findByIdForUpdate(db: Db, tenantId: string, orderId: string): Promise<Order | null> {
    const [row] = await db
      .select()
      .from(orders)
      .where(and(eq(orders.id, orderId), eq(orders.tenantId, tenantId), isNull(orders.deletedAt)))
      .for('update')
      .limit(1);
    return row ?? null;
  }

  /**
   * Set `orders.status` (+ bump `updated_at`) for one tenant-scoped order. Returns the
   * updated row, or null if no matching live row. Runs inside the caller's `tx`.
   * Tenant-scoped.
   */
  async updateStatus(
    tx: Tx,
    tenantId: string,
    orderId: string,
    status: OrderStatus,
  ): Promise<Order | null> {
    const [row] = await tx
      .update(orders)
      .set({ status, updatedAt: new Date() })
      .where(and(eq(orders.id, orderId), eq(orders.tenantId, tenantId), isNull(orders.deletedAt)))
      .returning();
    return row ?? null;
  }

  /**
   * Append one append-only `order_status_history` row inside the caller's `tx`.
   * Tenant-scoped (tenant_id is written explicitly and matches the order's tenant).
   */
  async insertStatusHistory(tx: Tx, input: StatusHistoryInput): Promise<OrderStatusHistory> {
    const [row] = await tx
      .insert(orderStatusHistory)
      .values({
        id: uuidv7(),
        tenantId: input.tenantId,
        orderId: input.orderId,
        fromStatus: input.fromStatus,
        toStatus: input.toStatus,
        changedBy: input.changedBy ?? null,
        note: input.note ?? null,
      })
      .returning();
    return row!;
  }

  // ── Reads (admin + store order read) ──────────────────────────────────────────

  /**
   * Offset-paginated, tenant-scoped order list (newest first). Optional `status` /
   * `customerId` facets. Excludes soft-deleted orders. Mirrors the customer admin list
   * (`{ data, total, page, pageSize }`). Tenant-scoped.
   */
  async listForTenant(tenantId: string, filters: OrderListFilters): Promise<OrderListResult> {
    const conditions = [eq(orders.tenantId, tenantId), isNull(orders.deletedAt)];
    if (filters.q) {
      // Escape LIKE metacharacters so a query like "50%" or "a_b" is matched literally.
      // `\` is the default LIKE escape character in Postgres.
      const escaped = filters.q.replace(/[\\%_]/g, (ch) => `\\${ch}`);
      conditions.push(ilike(orders.orderNumber, `%${escaped}%`));
    }
    if (filters.status) conditions.push(eq(orders.status, filters.status));
    if (filters.customerId) conditions.push(eq(orders.customerId, filters.customerId));
    const where = and(...conditions);

    const offset = (filters.page - 1) * filters.pageSize;
    const data = await this.db
      .select()
      .from(orders)
      .where(where)
      .orderBy(desc(orders.createdAt), desc(orders.id))
      .limit(filters.pageSize)
      .offset(offset);

    const [totalRow] = await this.db.select({ value: count() }).from(orders).where(where);
    return {
      data,
      total: Number(totalRow?.value ?? 0),
      page: filters.page,
      pageSize: filters.pageSize,
    };
  }

  /**
   * Load one tenant-scoped order (excludes soft-deleted). Returns null when missing/
   * deleted in this tenant. Tenant-scoped. Non-locking (read path).
   */
  async findById(tenantId: string, orderId: string): Promise<Order | null> {
    const [row] = await this.db
      .select()
      .from(orders)
      .where(and(eq(orders.id, orderId), eq(orders.tenantId, tenantId), isNull(orders.deletedAt)))
      .limit(1);
    return row ?? null;
  }

  /** Load one order by its per-tenant human order number. */
  async findByOrderNumber(tenantId: string, orderNumber: string): Promise<Order | null> {
    const [row] = await this.db
      .select()
      .from(orders)
      .where(
        and(
          eq(orders.orderNumber, orderNumber),
          eq(orders.tenantId, tenantId),
          isNull(orders.deletedAt),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /**
   * Load one tenant-scoped order that ALSO belongs to `customerId` (the store/own-order
   * read — no IDOR: another customer's order id resolves to null → the controller 404s).
   * Excludes soft-deleted + guest orders (a null customer_id never matches). Tenant-scoped.
   */
  async findByIdForCustomer(
    tenantId: string,
    orderId: string,
    customerId: string,
  ): Promise<Order | null> {
    const [row] = await this.db
      .select()
      .from(orders)
      .where(
        and(
          eq(orders.id, orderId),
          eq(orders.tenantId, tenantId),
          eq(orders.customerId, customerId),
          isNull(orders.deletedAt),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /**
   * Stale-unpaid sweep candidates: `pending_payment` orders created before `cutoff`,
   * oldest first, capped at `limit`. Cross-tenant by design (the cron runs globally;
   * v1 is single-tenant but tenant_id is threaded). Excludes
   * soft-deleted AND any order with an IN-FLIGHT payment (`processing` = async SEPA clearing, or
   * `succeeded`) — those must never be auto-cancelled. A SEPA that later FAILS leaves only a
   * `failed` row → the order becomes sweepable again. The sweeper re-checks each under the row lock
   * (expectedFrom) before cancelling, so a payment landing after this read can never be cancelled.
   */
  async findStalePendingPayment(
    cutoff: Date,
    limit: number,
  ): Promise<{ id: string; tenantId: string }[]> {
    return this.db
      .select({ id: orders.id, tenantId: orders.tenantId })
      .from(orders)
      .where(
        and(
          eq(orders.status, 'pending_payment'),
          isNull(orders.deletedAt),
          lt(orders.createdAt, cutoff),
          // Shield in-flight payments (SEPA clearing / already-succeeded) from auto-cancel.
          notExists(
            this.db
              .select({ one: sql`1` })
              .from(payments)
              .where(
                and(
                  eq(payments.orderId, orders.id),
                  eq(payments.tenantId, orders.tenantId),
                  inArray(payments.status, ['processing', 'succeeded']),
                ),
              ),
          ),
        ),
      )
      .orderBy(orders.createdAt)
      .limit(limit);
  }

  /**
   * Does this order have an in-flight payment — a `payments` row in `processing` (async SEPA
   * clearing) or `succeeded`? This is the single
   * primitive that guards the THREE admin/system paths that drive `→ paid` outside the webhook:
   * the payment-intent endpoint (don't mint a 2nd intent over a clearing SEPA), the manual-payment
   * endpoint, and the stale-unpaid sweeper's cancel — each consulting it (the latter two INSIDE
   * their transition tx, under the order row lock, to close the read-then-act TOCTOU). Tenant-scoped.
   * Accepts a `db`/`tx` so it can run inside the caller's transaction.
   */
  async hasInFlightPayment(tenantId: string, orderId: string, db: Db = this.db): Promise<boolean> {
    const [row] = await db
      .select({ one: sql<number>`1` })
      .from(payments)
      .where(
        and(
          eq(payments.orderId, orderId),
          eq(payments.tenantId, tenantId),
          inArray(payments.status, ['processing', 'succeeded']),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  /**
   * Find the order created from a given cart. Used by the
   * payment-intent endpoint's idempotent load-or-create: a retried PI request on an
   * already-`converted` cart resolves to its existing order. Newest-first + LIMIT 1 is
   * defensive — `markCartConverted` only fires once per cart so at most one order exists.
   * Excludes soft-deleted. Tenant-scoped. Non-locking.
   */
  async findByCartId(tenantId: string, cartId: string): Promise<Order | null> {
    const [row] = await this.db
      .select()
      .from(orders)
      .where(
        and(eq(orders.tenantId, tenantId), eq(orders.cartId, cartId), isNull(orders.deletedAt)),
      )
      .orderBy(desc(orders.createdAt), desc(orders.id))
      .limit(1);
    return row ?? null;
  }

  /** A customer's own orders, newest first, tenant-scoped (excludes soft-deleted). */
  async listForCustomer(tenantId: string, customerId: string): Promise<Order[]> {
    return this.db
      .select()
      .from(orders)
      .where(
        and(
          eq(orders.tenantId, tenantId),
          eq(orders.customerId, customerId),
          isNull(orders.deletedAt),
        ),
      )
      .orderBy(desc(orders.createdAt), desc(orders.id));
  }

  /**
   * Increment `orders.refunded_amount` by `delta` inside the refund tx.
   * Tenant-scoped; the order is already FOR UPDATE-locked by the caller.
   */
  async incrementRefundedAmount(
    tx: Tx,
    tenantId: string,
    orderId: string,
    delta: number,
  ): Promise<void> {
    await tx
      .update(orders)
      .set({ refundedAmount: sql`${orders.refundedAmount} + ${delta}`, updatedAt: new Date() })
      .where(and(eq(orders.id, orderId), eq(orders.tenantId, tenantId)));
  }

  /**
   * Increment `order_items.refunded_quantity`. Keeps the per-line refunded tally accurate
   * for the returns flow + reporting. Tenant-scoped.
   */
  async incrementRefundedQuantity(
    tx: Tx,
    tenantId: string,
    orderItemId: string,
    delta: number,
  ): Promise<void> {
    await tx
      .update(orderItems)
      .set({ refundedQuantity: sql`${orderItems.refundedQuantity} + ${delta}` })
      .where(and(eq(orderItems.id, orderItemId), eq(orderItems.tenantId, tenantId)));
  }

  /**
   * BACK OUT the optimistic reservation made for a PENDING async refund that the gateway
   * later REJECTED. CLAMPED at 0 (`greatest(refunded_amount − delta, 0)`) so a back-out can never
   * drive the column negative even under a double event. Tenant-scoped; order FOR UPDATE-locked
   * by the caller.
   */
  async decrementRefundedAmount(
    tx: Tx,
    tenantId: string,
    orderId: string,
    delta: number,
  ): Promise<void> {
    await tx
      .update(orders)
      .set({
        refundedAmount: sql`greatest(${orders.refundedAmount} - ${delta}, 0)`,
        updatedAt: new Date(),
      })
      .where(and(eq(orders.id, orderId), eq(orders.tenantId, tenantId)));
  }

  /** Back out a per-line refunded-quantity reservation (clamped ≥ 0). Tenant-scoped. */
  async decrementRefundedQuantity(
    tx: Tx,
    tenantId: string,
    orderItemId: string,
    delta: number,
  ): Promise<void> {
    await tx
      .update(orderItems)
      .set({ refundedQuantity: sql`greatest(${orderItems.refundedQuantity} - ${delta}, 0)` })
      .where(and(eq(orderItems.id, orderItemId), eq(orderItems.tenantId, tenantId)));
  }

  /** Load specific order items by id within an order (refund line validation). Tenant-scoped. */
  async getOrderItemsByIds(
    tx: Tx,
    tenantId: string,
    orderId: string,
    ids: string[],
  ): Promise<OrderItem[]> {
    if (ids.length === 0) return [];
    return tx
      .select()
      .from(orderItems)
      .where(
        and(
          eq(orderItems.tenantId, tenantId),
          eq(orderItems.orderId, orderId),
          inArray(orderItems.id, ids),
        ),
      );
  }

  /** The line items of one order, tenant-scoped, in insertion order. */
  async itemsForOrder(tenantId: string, orderId: string): Promise<OrderItem[]> {
    return this.db
      .select()
      .from(orderItems)
      .where(and(eq(orderItems.tenantId, tenantId), eq(orderItems.orderId, orderId)))
      .orderBy(orderItems.createdAt, orderItems.id);
  }

  /**
   * The timestamp the order was DELIVERED (latest `to_status='delivered'` history row), or null if
   * never delivered. The 14-day withdrawal window runs from here.
   */
  async getDeliveredAt(tenantId: string, orderId: string): Promise<Date | null> {
    const [row] = await this.db
      .select({ at: orderStatusHistory.createdAt })
      .from(orderStatusHistory)
      .where(
        and(
          eq(orderStatusHistory.tenantId, tenantId),
          eq(orderStatusHistory.orderId, orderId),
          eq(orderStatusHistory.toStatus, 'delivered'),
        ),
      )
      .orderBy(desc(orderStatusHistory.createdAt))
      .limit(1);
    return row?.at ?? null;
  }

  /** The append-only status history of one order, tenant-scoped, oldest first. */
  async historyForOrder(tenantId: string, orderId: string): Promise<OrderStatusHistory[]> {
    return this.db
      .select()
      .from(orderStatusHistory)
      .where(
        and(eq(orderStatusHistory.tenantId, tenantId), eq(orderStatusHistory.orderId, orderId)),
      )
      .orderBy(orderStatusHistory.createdAt, orderStatusHistory.id);
  }

  // ── createFromCart support ────────────────────────────────────────────────────

  /**
   * Row-lock the `carts` row FOR UPDATE inside the order transaction — the
   * double-submit / concurrency guard. Two simultaneous checkouts of the same cart
   * serialise here; the second sees `status='converted'` and 409s. Returns the locked
   * row (status only) or null when the cart row is absent. Tenant-scoped.
   */
  async lockCartRowForUpdate(
    tx: Tx,
    tenantId: string,
    cartId: string,
  ): Promise<{ status: string } | null> {
    const [row] = await tx
      .select({ status: carts.status })
      .from(carts)
      .where(and(eq(carts.id, cartId), eq(carts.tenantId, tenantId)))
      .for('update')
      .limit(1);
    return row ?? null;
  }

  /**
   * Allocate the next per-tenant `order_number` under the order tx. Upserts
   * the counter row (default 1) and atomically increments `next_value`, returning the
   * value handed out. Numbers MAY gap (a rolled-back order does not reuse its number).
   */
  async allocateOrderNumber(tx: Tx, tenantId: string): Promise<bigint> {
    const [row] = await tx
      .insert(orderCounters)
      .values({ tenantId, nextValue: 2n })
      .onConflictDoUpdate({
        target: orderCounters.tenantId,
        set: { nextValue: sql`${orderCounters.nextValue} + 1`, updatedAt: new Date() },
      })
      .returning({ nextValue: orderCounters.nextValue });
    // On INSERT we reserved value 1 (and stored next=2); on UPDATE the returned
    // next_value is the now-incremented counter, so the allocated number is value−1.
    const next = row!.nextValue;
    return next - 1n;
  }

  /**
   * Set/clear `orders.fulfillment_frozen`. Tenant-scoped. Idempotent
   * (re-freezing an already-frozen order is a no-op write). Used by the dispute webhook handler.
   */
  async setFulfillmentFrozen(
    tenantId: string,
    orderId: string,
    frozen: boolean,
    db: Db = this.db,
  ): Promise<void> {
    await db
      .update(orders)
      .set({ fulfillmentFrozen: frozen, updatedAt: new Date() })
      .where(and(eq(orders.id, orderId), eq(orders.tenantId, tenantId)));
  }

  /** Insert the order header inside the caller's tx; returns the inserted row. */
  async insertOrder(tx: Tx, values: NewOrder): Promise<Order> {
    const [row] = await tx.insert(orders).values(values).returning();
    return row!;
  }

  /** Insert all order line items inside the caller's tx. */
  async insertOrderItems(tx: Tx, values: NewOrderItem[]): Promise<void> {
    if (values.length === 0) return;
    await tx.insert(orderItems).values(values);
  }

  /**
   * Flip the cart to `converted` inside the order transaction. Only an `active` cart
   * is converted; returns true on success. Tenant-scoped.
   */
  async markCartConverted(tx: Tx, tenantId: string, cartId: string): Promise<boolean> {
    const updated = await tx
      .update(carts)
      .set({ status: 'converted', updatedAt: new Date() })
      .where(and(eq(carts.id, cartId), eq(carts.tenantId, tenantId), eq(carts.status, 'active')))
      .returning({ id: carts.id });
    return updated.length > 0;
  }

  /**
   * Resolve the priced/catalogue metadata for a set of variant ids in one tenant-scoped
   * query: variant title/sku/price + its product's title + is_bundle. Used to snapshot
   * order lines and to detect bundle lines. Returns a Map keyed by variant id.
   */
  async loadVariantsForSnapshot(
    tx: Tx,
    tenantId: string,
    variantIds: string[],
  ): Promise<
    Map<
      string,
      {
        variantId: string;
        productId: string;
        productTitle: string;
        variantTitle: string | null;
        sku: string;
        priceAmount: number;
        currency: string;
        isBundle: boolean;
      }
    >
  > {
    const out = new Map<
      string,
      {
        variantId: string;
        productId: string;
        productTitle: string;
        variantTitle: string | null;
        sku: string;
        priceAmount: number;
        currency: string;
        isBundle: boolean;
      }
    >();
    if (variantIds.length === 0) return out;
    const rows = await tx
      .select({
        variantId: productVariants.id,
        productId: productVariants.productId,
        productTitle: products.title,
        variantTitle: productVariants.title,
        sku: productVariants.sku,
        priceAmount: productVariants.priceAmount,
        currency: productVariants.currency,
        isBundle: products.isBundle,
      })
      .from(productVariants)
      .innerJoin(
        products,
        and(
          eq(productVariants.productId, products.id),
          eq(productVariants.tenantId, products.tenantId),
        ),
      )
      .where(and(eq(productVariants.tenantId, tenantId), inArray(productVariants.id, variantIds)));
    for (const r of rows) out.set(r.variantId, r);
    return out;
  }

  /**
   * Load the constituent (variantId, quantity) rows for a bundle product, tenant-scoped.
   * Used to explode a bundle cart line into the component variants whose stock is consumed.
   */
  async loadBundleComponents(
    tx: Tx,
    tenantId: string,
    bundleProductId: string,
  ): Promise<{ variantId: string; quantity: number }[]> {
    return tx
      .select({ variantId: bundleItems.variantId, quantity: bundleItems.quantity })
      .from(bundleItems)
      .where(
        and(eq(bundleItems.tenantId, tenantId), eq(bundleItems.bundleProductId, bundleProductId)),
      );
  }

  // ── Discount usage-consume ────────────────────────────────────────────────────

  /**
   * Row-LOCK the given discount rows `FOR UPDATE` inside the order tx and return their
   * live usage state (`usedCount` + the two limits). This is the serialization point
   * for the usage-limit race: two concurrent checkouts redeeming the SAME discount
   * block here, so the second reads the first's committed `used_count` and can be
   * rejected before it over-redeems. Tenant-scoped. Locked in a stable id order
   * (callers pass a deterministic id list) to avoid lock-ordering deadlocks.
   */
  async lockDiscountsForUpdate(
    tx: Tx,
    tenantId: string,
    discountIds: string[],
  ): Promise<
    Map<
      string,
      {
        usedCount: number;
        usageLimitTotal: number | null;
        usageLimitPerCustomer: number | null;
      }
    >
  > {
    const out = new Map<
      string,
      { usedCount: number; usageLimitTotal: number | null; usageLimitPerCustomer: number | null }
    >();
    if (discountIds.length === 0) return out;
    const rows = await tx
      .select({
        id: discounts.id,
        usedCount: discounts.usedCount,
        usageLimitTotal: discounts.usageLimitTotal,
        usageLimitPerCustomer: discounts.usageLimitPerCustomer,
      })
      .from(discounts)
      .where(and(eq(discounts.tenantId, tenantId), inArray(discounts.id, discountIds)))
      .orderBy(discounts.id)
      .for('update');
    for (const r of rows) {
      out.set(r.id, {
        usedCount: r.usedCount,
        usageLimitTotal: r.usageLimitTotal,
        usageLimitPerCustomer: r.usageLimitPerCustomer,
      });
    }
    return out;
  }

  /**
   * Count a customer's prior redemptions of ONE discount inside the order tx (for the
   * `usage_limit_per_customer` re-check). Read after the discount row is locked so the
   * count reflects all committed prior usages. Tenant-scoped.
   */
  async countCustomerDiscountUsages(
    tx: Tx,
    tenantId: string,
    discountId: string,
    customerId: string,
  ): Promise<number> {
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(discountUsages)
      .where(
        and(
          eq(discountUsages.tenantId, tenantId),
          eq(discountUsages.discountId, discountId),
          eq(discountUsages.customerId, customerId),
        ),
      );
    return row?.n ?? 0;
  }

  /**
   * Count a GUEST's prior redemptions of ONE discount inside the order tx, keyed on the
   * NORMALIZED (lowercased) email (the `usage_limit_per_customer` re-check for guest
   * checkouts). Read after the discount row is locked so the count reflects committed
   * prior usages. Tenant-scoped.
   */
  async countGuestDiscountUsages(
    tx: Tx,
    tenantId: string,
    discountId: string,
    email: string,
  ): Promise<number> {
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(discountUsages)
      .where(
        and(
          eq(discountUsages.tenantId, tenantId),
          eq(discountUsages.discountId, discountId),
          sql`lower(${discountUsages.email}) = ${email.toLowerCase()}`,
        ),
      );
    return row?.n ?? 0;
  }

  /** Insert one `discount_usages` row inside the order tx. Tenant-scoped. */
  async insertDiscountUsage(
    tx: Tx,
    input: {
      tenantId: string;
      discountId: string;
      orderId: string;
      customerId: string | null;
      email: string | null;
      amount: number;
    },
  ): Promise<void> {
    await tx.insert(discountUsages).values({
      id: uuidv7(),
      tenantId: input.tenantId,
      discountId: input.discountId,
      orderId: input.orderId,
      customerId: input.customerId,
      email: input.email,
      amount: input.amount,
    });
  }

  /**
   * Increment `discounts.used_count` by one inside the order tx (the discount row is
   * already locked via `lockDiscountsForUpdate`). Keeps `used_count == count(discount_usages)`
   * for the discount. Tenant-scoped.
   */
  async bumpUsedCount(tx: Tx, tenantId: string, discountId: string): Promise<void> {
    await tx
      .update(discounts)
      .set({ usedCount: sql`${discounts.usedCount} + 1`, updatedAt: new Date() })
      .where(and(eq(discounts.tenantId, tenantId), eq(discounts.id, discountId)));
  }
}
