/**
 * the broker read-port adapter.
 *
 * THE single place where module-visible core data is selected. Every query here is:
 *   - **tenant-scoped** (the `tenantId` comes from the broker context / worker identity);
 *   - **read-only** + **projected** to the narrow `Module*Dto` (the type is the privacy boundary
 *     — `ModuleCustomerDto` deliberately omits email/phone/address/VAT, so `read:customers` can
 *     never leak PII);
 *   - **keyset-paginated** by the uuidv7 `id` (sortable), bounded by the broker's limit;
 * - **soft-delete aware** for orders + customers: deleted rows are invisible.
 *
 * Keeping all of this in one small, auditable file (rather than threading bespoke per-service
 * read methods) makes the data a module can see trivial to review.
 */
import { Injectable } from '@nestjs/common';
import { and, asc, eq, gt, inArray, isNull } from 'drizzle-orm';

import { DatabaseService } from '../../database/database.service';
import { products } from '../../database/schema/products';
import { categories } from '../../database/schema/categories';
import { productCategories } from '../../database/schema/product_categories';
import { productVariants } from '../../database/schema/product_variants';
import { orders } from '../../database/schema/orders';
import { orderItems } from '../../database/schema/order_items';
import { customers } from '../../database/schema/customers';
import type {
  BrokerReadPorts,
  CategoryReadPort,
  CommerceReadPort,
  CustomerReadPort,
  ListQuery,
  ListResult,
  ModuleCategoryDto,
  ModuleCustomerDto,
  ModuleOrderDto,
  ModuleProductCategory,
  ModuleProductDto,
  OrderReadPort,
  ProductReadPort,
} from './broker-ports';

/**
 * Order statuses that count as a completed PURCHASE for the `commerce.hasPurchased` probe (B1):
 * any state at or past `paid`. `pending_payment` is NOT a purchase (money not taken) and
 * `cancelled` never was one. `refunded`/`partially_refunded` ARE included — the customer DID buy
 * the product (a later refund does not retroactively un-purchase it for review-eligibility).
 */
const PURCHASED_ORDER_STATUSES = [
  'paid',
  'fulfilled',
  'shipped',
  'delivered',
  'completed',
  'partially_refunded',
  'refunded',
] as const;

@Injectable()
export class BrokerReadAdapter implements BrokerReadPorts {
  readonly products: ProductReadPort;
  readonly categories: CategoryReadPort;
  readonly orders: OrderReadPort;
  readonly customers: CustomerReadPort;
  readonly commerce: CommerceReadPort;

  // Bind the ports in the constructor body so `this.database` is assigned first (parameter
  // properties land before the body; field initializers would see it undefined).
  constructor(private readonly database: DatabaseService) {
    this.products = {
      list: (t, q) => this.listProducts(t, q),
      get: (t, id) => this.getProduct(t, id),
    };
    this.categories = {
      list: (t, q) => this.listCategories(t, q),
      get: (t, id) => this.getCategory(t, id),
    };
    this.orders = {
      list: (t, q) => this.listOrders(t, q),
      get: (t, id) => this.getOrder(t, id),
    };
    this.customers = {
      list: (t, q) => this.listCustomers(t, q),
      get: (t, id) => this.getCustomer(t, id),
    };
    this.commerce = {
      hasPurchased: (t, customerId, productId) => this.hasPurchased(t, customerId, productId),
    };
  }

  private get db() {
    return this.database.db;
  }

  // ── products (with read-only primary-category metadata, B1) ─────────────────────
  private async listProducts(
    tenantId: string,
    q: ListQuery,
  ): Promise<ListResult<ModuleProductDto>> {
    const conds = [eq(products.tenantId, tenantId)];
    if (q.cursor) conds.push(gt(products.id, q.cursor));
    const rows = await this.db
      .select({
        id: products.id,
        slug: products.slug,
        title: products.title,
        status: products.status,
      })
      .from(products)
      .where(and(...conds))
      .orderBy(asc(products.id))
      .limit(q.limit + 1);
    const pageResult = page(rows, q.limit);
    // Resolve each kept product's primary category in ONE batched query (no N+1).
    const byProduct = await this.primaryCategoriesOf(
      tenantId,
      pageResult.items.map((r) => r.id),
    );
    return {
      items: pageResult.items.map((r) => withCategory(r, byProduct.get(r.id))),
      nextCursor: pageResult.nextCursor,
    };
  }
  private async getProduct(tenantId: string, id: string): Promise<ModuleProductDto | null> {
    const [row] = await this.db
      .select({
        id: products.id,
        slug: products.slug,
        title: products.title,
        status: products.status,
      })
      .from(products)
      .where(and(eq(products.tenantId, tenantId), eq(products.id, id)))
      .limit(1);
    if (!row) return null;
    const byProduct = await this.primaryCategoriesOf(tenantId, [row.id]);
    return withCategory(row, byProduct.get(row.id));
  }

  /**
   * Resolve each product's PRIMARY category (lowest `position`, id-tiebroken) in one tenant-scoped
   * query over `product_categories` JOIN `categories`. Read-only catalog metadata — rides
   * `read:products`. Returns a map of productId → its primary category (absent → no category).
   */
  private async primaryCategoriesOf(
    tenantId: string,
    productIds: readonly string[],
  ): Promise<Map<string, ModuleProductCategory>> {
    const out = new Map<string, ModuleProductCategory>();
    if (productIds.length === 0) return out;
    // Per-call ranking of the winning (position, id) for each product (no shared state).
    const primaryRank = new Map<string, { position: number; id: string }>();
    const rows = await this.db
      .select({
        productId: productCategories.productId,
        id: categories.id,
        slug: categories.slug,
        name: categories.name,
        position: categories.position,
      })
      .from(productCategories)
      .innerJoin(
        categories,
        and(
          eq(categories.id, productCategories.categoryId),
          eq(categories.tenantId, productCategories.tenantId),
        ),
      )
      .where(
        and(
          eq(productCategories.tenantId, tenantId),
          inArray(productCategories.productId, [...productIds]),
        ),
      );
    // Pick the primary per product deterministically: lowest position, then lowest category id.
    for (const r of rows) {
      const current = out.get(r.productId);
      if (!current) {
        out.set(r.productId, { id: r.id, slug: r.slug, name: r.name });
        primaryRank.set(r.productId, { position: r.position, id: r.id });
        continue;
      }
      const rank = primaryRank.get(r.productId)!;
      if (r.position < rank.position || (r.position === rank.position && r.id < rank.id)) {
        out.set(r.productId, { id: r.id, slug: r.slug, name: r.name });
        primaryRank.set(r.productId, { position: r.position, id: r.id });
      }
    }
    return out;
  }

  // ── categories ────────────────────────────────────────────────────────────────
  private async listCategories(
    tenantId: string,
    q: ListQuery,
  ): Promise<ListResult<ModuleCategoryDto>> {
    const conds = [eq(categories.tenantId, tenantId)];
    if (q.cursor) conds.push(gt(categories.id, q.cursor));
    const rows = await this.db
      .select({ id: categories.id, slug: categories.slug, name: categories.name })
      .from(categories)
      .where(and(...conds))
      .orderBy(asc(categories.id))
      .limit(q.limit + 1);
    return page(rows, q.limit);
  }
  private async getCategory(tenantId: string, id: string): Promise<ModuleCategoryDto | null> {
    const [row] = await this.db
      .select({ id: categories.id, slug: categories.slug, name: categories.name })
      .from(categories)
      .where(and(eq(categories.tenantId, tenantId), eq(categories.id, id)))
      .limit(1);
    return row ?? null;
  }

  // ── orders (soft-delete aware) ──────────────────────────────────────────────────
  private async listOrders(tenantId: string, q: ListQuery): Promise<ListResult<ModuleOrderDto>> {
    const conds = [eq(orders.tenantId, tenantId), isNull(orders.deletedAt)];
    if (q.cursor) conds.push(gt(orders.id, q.cursor));
    const rows = await this.db
      .select({
        id: orders.id,
        number: orders.orderNumber,
        status: orders.status,
        totalMinor: orders.totalAmount,
        currency: orders.currency,
        createdAt: orders.createdAt,
      })
      .from(orders)
      .where(and(...conds))
      .orderBy(asc(orders.id))
      .limit(q.limit + 1);
    return page(rows.map(toOrderDto), q.limit);
  }
  private async getOrder(tenantId: string, id: string): Promise<ModuleOrderDto | null> {
    const [row] = await this.db
      .select({
        id: orders.id,
        number: orders.orderNumber,
        status: orders.status,
        totalMinor: orders.totalAmount,
        currency: orders.currency,
        createdAt: orders.createdAt,
      })
      .from(orders)
      .where(and(eq(orders.tenantId, tenantId), eq(orders.id, id), isNull(orders.deletedAt)))
      .limit(1);
    return row ? toOrderDto(row) : null;
  }

  // ── customers (FIELD-LIMITED + soft-delete aware) ───────────────────────────────
  private async listCustomers(
    tenantId: string,
    q: ListQuery,
  ): Promise<ListResult<ModuleCustomerDto>> {
    const conds = [eq(customers.tenantId, tenantId), isNull(customers.deletedAt)];
    if (q.cursor) conds.push(gt(customers.id, q.cursor));
    // SELECT only the non-PII columns — never email/phone/vat/address.
    const rows = await this.db
      .select({ id: customers.id, name: customers.name, createdAt: customers.createdAt })
      .from(customers)
      .where(and(...conds))
      .orderBy(asc(customers.id))
      .limit(q.limit + 1);
    return page(rows.map(toCustomerDto), q.limit);
  }
  private async getCustomer(tenantId: string, id: string): Promise<ModuleCustomerDto | null> {
    const [row] = await this.db
      .select({ id: customers.id, name: customers.name, createdAt: customers.createdAt })
      .from(customers)
      .where(
        and(eq(customers.tenantId, tenantId), eq(customers.id, id), isNull(customers.deletedAt)),
      )
      .limit(1);
    return row ? toCustomerDto(row) : null;
  }

  // ── commerce (boolean-only purchase probe, B1) ─────────────────────────────────
  /**
   * True iff THIS tenant has a non-deleted, paid-or-later order for `customerId` containing
   * `productId`. The product is matched through the line item's variant → product relation
   * (`order_items.variant_id` → `product_variants.product_id`). All three predicates — tenant,
   * customer, product — and the status set are bound params. Returns ONLY a boolean: no order row,
   * id, or amount leaves this method (least-privilege). `EXISTS`/`LIMIT 1` so it short-circuits.
   *
   * KNOWN LIMITATION (deleted-variant edge): `order_items.variant_id` is nullable with
   * `ON DELETE SET NULL` (French invoice-retention keeps the line after a variant is hard-deleted),
   * and the line carries NO `product_id` snapshot. So if a sold variant is later
   * hard-deleted, the variant→product join breaks and this returns `false` for a genuine buyer of
   * that product. That is acceptable: it errs toward DENY (a false negative, never a false
   * positive — a non-buyer can never be turned into a buyer). We deliberately add NO fallback match:
   * the variant row is gone, so a SKU/title fallback cannot recover the product link either.
   */
  private async hasPurchased(
    tenantId: string,
    customerId: string,
    productId: string,
  ): Promise<boolean> {
    const [row] = await this.db
      .select({ one: orderItems.id })
      .from(orderItems)
      .innerJoin(
        productVariants,
        and(
          eq(productVariants.id, orderItems.variantId),
          eq(productVariants.tenantId, orderItems.tenantId),
        ),
      )
      .innerJoin(
        orders,
        and(eq(orders.id, orderItems.orderId), eq(orders.tenantId, orderItems.tenantId)),
      )
      .where(
        and(
          eq(orderItems.tenantId, tenantId),
          eq(orders.customerId, customerId),
          eq(productVariants.productId, productId),
          isNull(orders.deletedAt),
          inArray(orders.status, [...PURCHASED_ORDER_STATUSES]),
        ),
      )
      .limit(1);
    return row !== undefined;
  }
}

/** Attach a resolved primary category (B1) to a base product projection; omit when absent. */
function withCategory(
  row: { id: string; slug: string; title: string; status: string },
  category: ModuleProductCategory | undefined,
): ModuleProductDto {
  return category ? { ...row, category } : { ...row };
}

/** Slice N+1 rows into a page + a next cursor (the last returned row's id). */
function page<T extends { id: string }>(rows: T[], limit: number): ListResult<T> {
  const items = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? items[items.length - 1]?.id : undefined;
  return { items, nextCursor };
}

function toOrderDto(row: {
  id: string;
  number: string;
  status: string;
  totalMinor: number;
  currency: string;
  createdAt: Date;
}): ModuleOrderDto {
  return { ...row, createdAt: row.createdAt.toISOString() };
}

function toCustomerDto(row: {
  id: string;
  name: string | null;
  createdAt: Date;
}): ModuleCustomerDto {
  // No `locale` column on customers → null. displayName falls back when name is null/anonymized.
  return {
    id: row.id,
    displayName: row.name ?? 'Customer',
    locale: null,
    createdAt: row.createdAt.toISOString(),
  };
}
