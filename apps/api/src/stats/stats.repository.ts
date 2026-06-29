/**
 * StatsRepository — tenant-scoped Drizzle aggregates for the admin dashboard.
 *
 * Money rules (revenue path — dual-reviewed):
 *  - Every money SUM is filtered to a SINGLE currency (the store's base currency).
 *    // ponytail: single-currency assumption. Multi-currency aggregation deferred to Phase 4.
 *    Currency is resolved by the caller (StatsService) via TenantSettingsService.defaultCurrency,
 *    falling back to the most recent placed order's currency. The resolved currency is threaded in
 *    as `currency` so this repo never silently sums across mixed currencies.
 *  - Revenue = SUM(total_amount - refunded_amount) for revenue-bearing orders.
 *    `refunded_amount` is kept current on the order row; do NOT join refunds here.
 *  - Revenue-bearing statuses: paid, fulfilled, shipped, delivered, completed, partially_refunded.
 *  - Window column: placed_at (NOT created_at). Always filter placed_at IS NOT NULL.
 *  - All queries filter deleted_at IS NULL on orders.
 *
 * DatabaseService is @Global — injected directly, no module import needed.
 */
import { Injectable } from '@nestjs/common';
import { and, eq, gte, gt, lte, isNull, isNotNull, inArray, sql, desc } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { orders } from '../database/schema/orders';
import { orderItems } from '../database/schema/order_items';
import { carts } from '../database/schema/carts';
import { customers } from '../database/schema/customers';
import { productVariants } from '../database/schema/product_variants';
import { returns } from '../database/schema/returns';
import { refunds } from '../database/schema/refunds';
import { orderStatusEnum, cartStatusEnum } from '../database/schema/_enums';

/** Revenue-bearing order statuses per spec (typed to satisfy Drizzle's PgEnum inArray). */
export const REVENUE_STATUSES = [
  'paid',
  'fulfilled',
  'shipped',
  'delivered',
  'completed',
  'partially_refunded',
] as const satisfies ReadonlyArray<(typeof orderStatusEnum.enumValues)[number]>;

export const LOW_STOCK_THRESHOLD = 5;

export interface RevenueWindow {
  /** Net revenue in integer minor units (SUM(total_amount - refunded_amount)). */
  netRevenue: number;
  /** Count of revenue-bearing orders placed in the window. */
  orderCount: number;
  /** Currency of the aggregated revenue. */
  currency: string;
}

export interface CustomerWindow {
  /** Count of new customers created in the window. */
  newCustomers: number;
}

export interface ReturnWindow {
  /** Count of returns with requested_at in the window (all statuses). */
  returnCount: number;
}

export interface RefundWindow {
  /** Sum of succeeded refunds.amount with created_at in the window, integer minor units. */
  refundAmount: number;
}

export interface CartConversionWindow {
  /** Count of carts with status='converted' (created_at in window). */
  converted: number;
  /** Count of carts with status='abandoned' (created_at in window). */
  abandoned: number;
}

export interface TimeseriesPoint {
  bucket: string; // YYYY-MM-DD (day), YYYY-Www (week), YYYY-MM (month)
  revenue: number; // integer minor units (net revenue per bucket)
  orders: number; // revenue-bearing order count per bucket
  newCustomers: number; // customers.created_at bucketed (deleted_at IS NULL)
  refundAmount: number; // integer minor units; succeeded refunds in the resolved currency
}

/** A single (status, count) pair within a placed_at window (pre-zero-fill). */
export interface StatusCount {
  status: (typeof orderStatusEnum.enumValues)[number];
  count: number;
}

/** New-vs-returning customer split for a window (guests excluded). */
export interface CustomerBreakdownData {
  newCustomers: number;
  returningCustomers: number;
}

export interface TopProductItem {
  productTitle: string;
  variantId: string | null;
  quantitySold: number;
  revenue: number; // integer minor units
}

export interface StockItem {
  variantId: string;
  productId: string;
  /**
   * Non-null per the frontend contract. `product_variants.title` is nullable in the DB,
   * so getAttention coalesces it to the (always-present) sku — a meaningful label in a
   * stock alert — rather than emit null.
   */
  title: string;
  sku: string;
  stockQuantity: number;
}

export interface AttentionData {
  lowStockItems: StockItem[];
  lowStockCount: number;
  outOfStockItems: StockItem[];
  outOfStockCount: number;
  pendingReturns: number;
  unfulfilledOrders: number;
  pendingPaymentOrders: number;
}

@Injectable()
export class StatsRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  /**
   * Resolve the store's base currency for a tenant.
   * Returns the currency of the most recent placed order (fallback if none found: 'EUR').
   * This is used when TenantSettingsService has no defaultCurrency configured.
   * // ponytail: derives base currency from most recent order; mixed-currency aggregation is a Phase-4 concern.
   */
  async resolveMostRecentOrderCurrency(tenantId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ currency: orders.currency })
      .from(orders)
      .where(
        and(eq(orders.tenantId, tenantId), isNull(orders.deletedAt), isNotNull(orders.placedAt)),
      )
      .orderBy(desc(orders.placedAt))
      .limit(1);
    return row?.currency ?? null;
  }

  /**
   * Aggregate revenue and order count for a given time window, filtered to a single currency.
   * // ponytail: single-currency filter applied; mixed-currency orders are excluded from aggregation.
   */
  async getRevenueWindow(
    tenantId: string,
    currency: string,
    from: Date,
    to: Date,
  ): Promise<RevenueWindow> {
    const [row] = await this.db
      .select({
        netRevenue: sql<string>`coalesce(sum(${orders.totalAmount} - ${orders.refundedAmount}), 0)`,
        orderCount: sql<string>`count(*)`,
      })
      .from(orders)
      .where(
        and(
          eq(orders.tenantId, tenantId),
          eq(orders.currency, currency),
          inArray(orders.status, REVENUE_STATUSES),
          isNotNull(orders.placedAt),
          isNull(orders.deletedAt),
          gte(orders.placedAt, from),
          lte(orders.placedAt, to),
        ),
      );
    return {
      netRevenue: Number(row?.netRevenue ?? 0),
      orderCount: Number(row?.orderCount ?? 0),
      currency,
    };
  }

  /** Count new customers (created_at in window, not deleted). */
  async getNewCustomersCount(tenantId: string, from: Date, to: Date): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<string>`count(*)` })
      .from(customers)
      .where(
        and(
          eq(customers.tenantId, tenantId),
          isNull(customers.deletedAt),
          gte(customers.createdAt, from),
          lte(customers.createdAt, to),
        ),
      );
    return Number(row?.n ?? 0);
  }

  /** Count returns with requested_at in window (tenant-scoped, any status). */
  async getReturnCount(tenantId: string, from: Date, to: Date): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<string>`count(*)` })
      .from(returns)
      .where(
        and(
          eq(returns.tenantId, tenantId),
          gte(returns.requestedAt, from),
          lte(returns.requestedAt, to),
        ),
      );
    return Number(row?.n ?? 0);
  }

  /** Sum succeeded refunds with created_at in window, filtered to the store currency. */
  async getRefundAmount(tenantId: string, currency: string, from: Date, to: Date): Promise<number> {
    const [row] = await this.db
      .select({ total: sql<string>`coalesce(sum(${refunds.amount}), 0)` })
      .from(refunds)
      .where(
        and(
          eq(refunds.tenantId, tenantId),
          eq(refunds.currency, currency),
          eq(refunds.status, 'succeeded'),
          gte(refunds.createdAt, from),
          lte(refunds.createdAt, to),
        ),
      );
    return Number(row?.total ?? 0);
  }

  /** Cart conversion counts (converted + abandoned) for carts created_at in window. */
  async getCartConversion(tenantId: string, from: Date, to: Date): Promise<CartConversionWindow> {
    const rows = await this.db
      .select({
        status: carts.status,
        n: sql<string>`count(*)`,
      })
      .from(carts)
      .where(
        and(
          eq(carts.tenantId, tenantId),
          inArray(carts.status, ['converted', 'abandoned'] as const satisfies ReadonlyArray<
            (typeof cartStatusEnum.enumValues)[number]
          >),
          gte(carts.createdAt, from),
          lte(carts.createdAt, to),
        ),
      )
      .groupBy(carts.status);

    let converted = 0;
    let abandoned = 0;
    for (const r of rows) {
      if (r.status === 'converted') converted = Number(r.n);
      else if (r.status === 'abandoned') abandoned = Number(r.n);
    }
    return { converted, abandoned };
  }

  /**
   * Zero-filled timeseries: one bucket per interval in [from, to].
   * Per bucket:
   *  - revenue: net revenue (revenue-bearing orders, placed_at window)
   *  - orders: revenue-bearing order count (placed_at window)
   *  - newCustomers: customers created in the bucket (customers.created_at, deleted_at IS NULL)
   *  - refundAmount: succeeded refunds in the bucket (refunds.created_at), filtered to `currency`
   *
   * Each metric uses a SEPARATE CTE (different source table + window column) LEFT JOINed to the
   * one `buckets` generate_series, so the chart is continuous (empty buckets zero-fill).
   * // ponytail: single-currency filter; mixed-currency orders/refunds excluded from timeseries.
   */
  async getTimeseries(
    tenantId: string,
    currency: string,
    from: Date,
    to: Date,
    granularity: 'day' | 'week' | 'month',
  ): Promise<TimeseriesPoint[]> {
    // Use a Postgres generate_series to zero-fill empty buckets.
    // The series is always truncated to [from, to] aligned to the granularity.
    const bucketFormat =
      granularity === 'day' ? 'YYYY-MM-DD' : granularity === 'week' ? 'IYYY-"W"IW' : 'YYYY-MM';
    // `granularity` is the ONLY request-derived value that reaches `sql.raw` here. The DTO
    // already enum-validates it, but per the money/security-path rule (never trust raw SQL
    // with interpolated input) we map it through an EXPLICIT in-function whitelist so even a
    // future caller bypassing the DTO cannot inject — `unit` is provably one of three literals.
    const TRUNC = { day: 'day', week: 'week', month: 'month' } as const;
    const unit = TRUNC[granularity];
    if (!unit) throw new Error(`invalid granularity: ${granularity}`);
    // `unit` (not `granularity`) is INLINED as a SQL literal (not a bound parameter). This is
    // LOAD-BEARING for correctness: if each `date_trunc(...)` bound the unit as its own
    // placeholder, Postgres would see `date_trunc($5, placed_at)` in SELECT and
    // `date_trunc($10, placed_at)` in GROUP BY as DIFFERENT expressions and reject the GROUP BY
    // (SQLSTATE 42803). The SAME `unit` literal is used in ALL date_trunc occurrences below
    // (generate_series start/end, SELECT, GROUP BY) so they stay textually identical.
    const trunc = sql.raw(`'${unit}'`);
    const intervalLiteral = sql.raw(`'1 ${unit}'`);
    // `statusList` is built from REVENUE_STATUSES — a COMPILE-TIME constant defined in this
    // file, NOT request input — so inlining it via sql.raw carries no injection surface.
    const statusList = sql.raw(
      'ARRAY[' + REVENUE_STATUSES.map((s) => `'${s}'`).join(',') + ']::order_status[]',
    );
    // The porsager `postgres` driver cannot bind a raw JS Date in a parameterised
    // `sql\`...\`` fragment (its Bind step expects a string) — bind ISO strings and
    // cast to timestamptz in SQL. (Drizzle's gte/lte column operators DO accept Date;
    // only these raw fragments need the conversion.)
    const fromIso = from.toISOString();
    const toIso = to.toISOString();

    const rawRows = await this.db.execute(
      sql`
        WITH buckets AS (
          SELECT generate_series(
            date_trunc(${trunc}, ${fromIso}::timestamptz),
            date_trunc(${trunc}, ${toIso}::timestamptz),
            ${intervalLiteral}::interval
          ) AS bucket
        ),
        agg AS (
          SELECT
            date_trunc(${trunc}, placed_at) AS bucket,
            coalesce(sum(total_amount - refunded_amount), 0) AS revenue,
            count(*)::bigint AS orders
          FROM orders
          WHERE
            tenant_id = ${tenantId}::uuid
            AND currency = ${currency}
            AND status = ANY(${statusList})
            AND placed_at IS NOT NULL
            AND deleted_at IS NULL
            AND placed_at >= ${fromIso}::timestamptz
            AND placed_at <= ${toIso}::timestamptz
          GROUP BY date_trunc(${trunc}, placed_at)
        ),
        -- New customers per bucket. DIFFERENT window column (customers.created_at, not
        -- orders.placed_at) → its own CTE, LEFT JOINed to the same buckets. Tenant-scoped,
        -- soft-deleted excluded.
        new_customers AS (
          SELECT
            date_trunc(${trunc}, created_at) AS bucket,
            count(*)::bigint AS new_customers
          FROM customers
          WHERE
            tenant_id = ${tenantId}::uuid
            AND deleted_at IS NULL
            AND created_at >= ${fromIso}::timestamptz
            AND created_at <= ${toIso}::timestamptz
          GROUP BY date_trunc(${trunc}, created_at)
        ),
        -- Succeeded refunds per bucket (refunds.created_at), filtered to the resolved currency so
        -- we never sum across currencies. Integer minor units. Its own CTE (different table +
        -- window column), LEFT JOINed to the same buckets. Tenant-scoped.
        refunds_agg AS (
          SELECT
            date_trunc(${trunc}, created_at) AS bucket,
            coalesce(sum(amount), 0) AS refund_amount
          FROM refunds
          WHERE
            tenant_id = ${tenantId}::uuid
            AND currency = ${currency}
            AND status = 'succeeded'
            AND created_at >= ${fromIso}::timestamptz
            AND created_at <= ${toIso}::timestamptz
          GROUP BY date_trunc(${trunc}, created_at)
        )
        SELECT
          to_char(b.bucket AT TIME ZONE 'UTC', ${bucketFormat}) AS bucket,
          coalesce(a.revenue, 0)::bigint AS revenue,
          coalesce(a.orders, 0)::bigint AS orders,
          coalesce(nc.new_customers, 0)::bigint AS new_customers,
          coalesce(r.refund_amount, 0)::bigint AS refund_amount
        FROM buckets b
        LEFT JOIN agg a ON b.bucket = a.bucket
        LEFT JOIN new_customers nc ON b.bucket = nc.bucket
        LEFT JOIN refunds_agg r ON b.bucket = r.bucket
        ORDER BY b.bucket
      `,
    );

    const series = rawRows as unknown as Array<{
      bucket: string;
      revenue: string;
      orders: string;
      new_customers: string;
      refund_amount: string;
    }>;
    return series.map((r) => ({
      bucket: r.bucket,
      revenue: Number(r.revenue ?? 0),
      orders: Number(r.orders ?? 0),
      newCustomers: Number(r.new_customers ?? 0),
      refundAmount: Number(r.refund_amount ?? 0),
    }));
  }

  /**
   * New-vs-returning customer split for a placed_at window. Guests (customer_id IS NULL) are
   * excluded. A customer counts if they placed ≥1 order in [from, to]; they are NEW if the
   * MIN(placed_at) across ALL their orders falls inside the window, RETURNING if their first
   * ever order predates `from`. Standard placed_at IS NOT NULL + deleted_at IS NULL filters.
   * Tenant-scoped (the inner per-customer first-order CTE is itself tenant-scoped, so a customer
   * id shared across tenants — should never happen given the composite FK — cannot leak).
   */
  async getCustomerBreakdown(
    tenantId: string,
    from: Date,
    to: Date,
  ): Promise<CustomerBreakdownData> {
    const fromIso = from.toISOString();
    const toIso = to.toISOString();

    const rawRows = await this.db.execute(
      sql`
        WITH first_orders AS (
          -- Each non-guest customer's FIRST-EVER order time (tenant-scoped, live orders only).
          SELECT
            customer_id,
            min(placed_at) AS first_placed_at
          FROM orders
          WHERE
            tenant_id = ${tenantId}::uuid
            AND customer_id IS NOT NULL
            AND placed_at IS NOT NULL
            AND deleted_at IS NULL
          GROUP BY customer_id
        ),
        in_window AS (
          -- Distinct non-guest customers who placed at least one order IN the window.
          SELECT DISTINCT customer_id
          FROM orders
          WHERE
            tenant_id = ${tenantId}::uuid
            AND customer_id IS NOT NULL
            AND placed_at IS NOT NULL
            AND deleted_at IS NULL
            AND placed_at >= ${fromIso}::timestamptz
            AND placed_at <= ${toIso}::timestamptz
        )
        SELECT
          count(*) FILTER (
            WHERE fo.first_placed_at >= ${fromIso}::timestamptz
              AND fo.first_placed_at <= ${toIso}::timestamptz
          )::bigint AS new_customers,
          count(*) FILTER (
            WHERE fo.first_placed_at < ${fromIso}::timestamptz
          )::bigint AS returning_customers
        FROM in_window iw
        JOIN first_orders fo ON fo.customer_id = iw.customer_id
      `,
    );

    const rows = rawRows as unknown as Array<{
      new_customers: string;
      returning_customers: string;
    }>;
    const row = rows[0];
    return {
      newCustomers: Number(row?.new_customers ?? 0),
      returningCustomers: Number(row?.returning_customers ?? 0),
    };
  }

  /**
   * Order count grouped by status within the placed_at window. Returns only statuses that
   * actually occur (the service zero-fills the full 9-status set). Tenant-scoped; excludes
   * soft-deleted + orders with no placed_at.
   */
  async getStatusBreakdown(tenantId: string, from: Date, to: Date): Promise<StatusCount[]> {
    const rows = await this.db
      .select({
        status: orders.status,
        count: sql<string>`count(*)`,
      })
      .from(orders)
      .where(
        and(
          eq(orders.tenantId, tenantId),
          isNotNull(orders.placedAt),
          isNull(orders.deletedAt),
          gte(orders.placedAt, from),
          lte(orders.placedAt, to),
        ),
      )
      .groupBy(orders.status);

    return rows.map((r) => ({ status: r.status, count: Number(r.count) }));
  }

  /**
   * Top products by revenue or quantity within the window, joined via orders.
   * Groups by product_title (snapshot column, per spec).
   * // ponytail: single-currency filter on the joined order; mixed-currency excluded.
   */
  async getTopProducts(
    tenantId: string,
    currency: string,
    from: Date,
    to: Date,
    limit: number,
    by: 'revenue' | 'quantity',
  ): Promise<TopProductItem[]> {
    const orderCol =
      by === 'revenue'
        ? sql`sum(${orderItems.lineTotalAmount}) DESC`
        : sql`sum(${orderItems.quantity}) DESC`;

    const rows = await this.db
      .select({
        productTitle: orderItems.productTitle,
        variantId: orderItems.variantId,
        quantitySold: sql<string>`sum(${orderItems.quantity})`,
        revenue: sql<string>`sum(${orderItems.lineTotalAmount})`,
      })
      .from(orderItems)
      .innerJoin(
        orders,
        and(eq(orderItems.orderId, orders.id), eq(orderItems.tenantId, orders.tenantId)),
      )
      .where(
        and(
          eq(orderItems.tenantId, tenantId),
          eq(orders.currency, currency),
          inArray(orders.status, REVENUE_STATUSES),
          isNotNull(orders.placedAt),
          isNull(orders.deletedAt),
          gte(orders.placedAt, from),
          lte(orders.placedAt, to),
        ),
      )
      .groupBy(orderItems.productTitle, orderItems.variantId)
      .orderBy(orderCol)
      .limit(limit);

    return rows.map((r) => ({
      productTitle: r.productTitle,
      variantId: r.variantId ?? null,
      quantitySold: Number(r.quantitySold),
      revenue: Number(r.revenue),
    }));
  }

  /**
   * Attention panel — current-state (NOT windowed).
   * Low/out-of-stock: product_variants with allow_backorder=false.
   * Pending returns: status='requested'.
   * Unfulfilled orders: status='paid' (paid but not yet fulfilled/shipped).
   * Pending payment: status='pending_payment'.
   * All tenant-scoped; deleted_at IS NULL on orders.
   * Item lists capped at 10 (counts are full totals).
   */
  async getAttention(tenantId: string): Promise<AttentionData> {
    // Low-stock: stock_quantity > 0 AND stock_quantity <= THRESHOLD AND allow_backorder = false
    const lowStockRows = await this.db
      .select({
        variantId: productVariants.id,
        productId: productVariants.productId,
        title: productVariants.title,
        sku: productVariants.sku,
        stockQuantity: productVariants.stockQuantity,
      })
      .from(productVariants)
      .where(
        and(
          eq(productVariants.tenantId, tenantId),
          eq(productVariants.allowBackorder, false),
          gt(productVariants.stockQuantity, 0),
          lte(productVariants.stockQuantity, LOW_STOCK_THRESHOLD),
        ),
      )
      .orderBy(productVariants.stockQuantity)
      .limit(10);

    const [lowStockCountRow] = await this.db
      .select({ n: sql<string>`count(*)` })
      .from(productVariants)
      .where(
        and(
          eq(productVariants.tenantId, tenantId),
          eq(productVariants.allowBackorder, false),
          gt(productVariants.stockQuantity, 0),
          lte(productVariants.stockQuantity, LOW_STOCK_THRESHOLD),
        ),
      );

    // Out-of-stock: stock_quantity <= 0 AND allow_backorder = false
    const outOfStockRows = await this.db
      .select({
        variantId: productVariants.id,
        productId: productVariants.productId,
        title: productVariants.title,
        sku: productVariants.sku,
        stockQuantity: productVariants.stockQuantity,
      })
      .from(productVariants)
      .where(
        and(
          eq(productVariants.tenantId, tenantId),
          eq(productVariants.allowBackorder, false),
          lte(productVariants.stockQuantity, 0),
        ),
      )
      .orderBy(productVariants.stockQuantity)
      .limit(10);

    const [outOfStockCountRow] = await this.db
      .select({ n: sql<string>`count(*)` })
      .from(productVariants)
      .where(
        and(
          eq(productVariants.tenantId, tenantId),
          eq(productVariants.allowBackorder, false),
          lte(productVariants.stockQuantity, 0),
        ),
      );

    // Pending returns
    const [pendingReturnsRow] = await this.db
      .select({ n: sql<string>`count(*)` })
      .from(returns)
      .where(and(eq(returns.tenantId, tenantId), eq(returns.status, 'requested')));

    // Unfulfilled orders = status='paid'
    const [unfulfilledRow] = await this.db
      .select({ n: sql<string>`count(*)` })
      .from(orders)
      .where(
        and(eq(orders.tenantId, tenantId), eq(orders.status, 'paid'), isNull(orders.deletedAt)),
      );

    // Pending payment orders
    const [pendingPaymentRow] = await this.db
      .select({ n: sql<string>`count(*)` })
      .from(orders)
      .where(
        and(
          eq(orders.tenantId, tenantId),
          eq(orders.status, 'pending_payment'),
          isNull(orders.deletedAt),
        ),
      );

    return {
      lowStockItems: lowStockRows.map((r) => ({
        variantId: r.variantId,
        productId: r.productId,
        // Coalesce nullable variant title to the always-present sku (keeps the
        // frontend contract's non-null `title`).
        title: r.title ?? r.sku,
        sku: r.sku,
        stockQuantity: r.stockQuantity,
      })),
      lowStockCount: Number(lowStockCountRow?.n ?? 0),
      outOfStockItems: outOfStockRows.map((r) => ({
        variantId: r.variantId,
        productId: r.productId,
        title: r.title ?? r.sku,
        sku: r.sku,
        stockQuantity: r.stockQuantity,
      })),
      outOfStockCount: Number(outOfStockCountRow?.n ?? 0),
      pendingReturns: Number(pendingReturnsRow?.n ?? 0),
      unfulfilledOrders: Number(unfulfilledRow?.n ?? 0),
      pendingPaymentOrders: Number(pendingPaymentRow?.n ?? 0),
    };
  }
}
