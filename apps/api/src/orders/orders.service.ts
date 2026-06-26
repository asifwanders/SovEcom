/**
 * OrderService — the order state machine driver.
 *
 * `transition` is the only way an order's status changes. In one transaction it:
 *   1. Loads + row-locks the order (`SELECT ... FOR UPDATE`) — serializes concurrent transitions,
 *   2. Validates `from → to` via `assertTransition` (422 on an illegal edge),
 *   3. Updates `orders.status`,
 *   4. Appends an append-only `order_status_history` row,
 * then — after commit — emits `order.<to>` via EventEmitter2 so side-effect listeners
 * (invoice, stock restore, emails) react. Emitting post-commit mirrors the catalog pattern:
 * a rolled-back transaction can never fire a phantom event.
 */
import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { type Order } from '../database/schema/orders';
import { customers } from '../database/schema/customers';
import { OrderRepository, type OrderListFilters, type OrderListResult } from './order.repository';
import { assertTransition, type OrderStatus } from './order-status';
import type { OrderItem } from '../database/schema/order_items';
import type { OrderStatusHistory } from '../database/schema/order_status_history';
import { OrderStatusChangedEvent } from './events/order-status-changed.event';
import { OrderCreatedEvent } from './events/order-created.event';
import { buildSnapshot, type SnapshotLineInput, type TaxBreakdown } from './order-snapshot';
import type { TaxResult } from '../taxes/engine/tax-resolver';
import type { AppliedDiscount } from '../discounts/discount-engine';
import { CartRepository } from '../cart/cart.repository';
import { InventoryService, type StockFlip } from '../inventory/inventory.service';
import { ProductStockChangedEvent } from '../catalog/events/product-stock-changed.event';
import { DiscountsService } from '../discounts/discounts.service';
import { TaxesService } from '../taxes/taxes.service';
import { TenantSettingsService } from '../taxes/tenant-settings.service';
import { ShippingService } from '../shipping/shipping.service';
import type { CartState } from '../cart/cart.types';
import type { AuthenticatedCustomer } from '../customers/auth/authenticated-customer';

/**
 * The created order plus the plaintext guest-lookup token, surfaced once at creation.
 * The token is runtime-only — it is not a persisted column and must never be logged or re-returned.
 */
export interface OrderWithGuestToken extends Order {
  guestAccessToken?: string;
}

/** Optional metadata recorded with a transition. */
export interface TransitionContext {
  /** The acting admin user id, or null/undefined for a system action. */
  changedBy?: string | null;
  /** Free-text note appended to the history row. */
  note?: string | null;
  /**
   * Optimistic-from guard. When set, the transition is applied ONLY if the order's CURRENT status
   * equals `expectedFrom` (checked under the row lock); otherwise it throws 409. The stale-unpaid
   * sweeper passes `'pending_payment'` so a payment landing between its scan and its cancel can
   * never cancel a just-paid order.
   */
  expectedFrom?: OrderStatus;
  /**
   * Optional async guard run INSIDE the transition tx, AFTER the row lock is taken and the
   * edge/expectedFrom checks pass, but BEFORE the status is written. Throw to abort+rollback.
   * Used to atomically re-check "does this order have an in-flight payment?" so a
   * `payment_intent.processing` (which does NOT change order status, so `expectedFrom` can't see it)
   * landing after a sweep scan / before a manual mark cannot cancel or double-collect a clearing SEPA.
   */
  precondition?: (tx: TransitionTx) => Promise<void>;
}

/** The transaction handle passed to a {@link TransitionContext.precondition}. */
export type TransitionTx = Parameters<Parameters<DatabaseService['db']['transaction']>[0]>[0];

/** The acting principal at checkout (a customer JWT or a guest cart-token caller). */
export interface CreateFromCartActor {
  /** The authenticated customer, if any (guest checkout → undefined). */
  customer?: AuthenticatedCustomer;
}

@Injectable()
export class OrderService {
  private readonly logger = new Logger(OrderService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly orders: OrderRepository,
    private readonly events: EventEmitter2,
    private readonly carts: CartRepository,
    private readonly inventory: InventoryService,
    private readonly discounts: DiscountsService,
    private readonly taxes: TaxesService,
    private readonly tenantSettings: TenantSettingsService,
    private readonly shipping: ShippingService,
  ) {}

  /**
   * Create an order from a cart — the MONEY-CRITICAL terminus. Runs the
   * ENTIRE flow in ONE db transaction so stock can never be decremented without a
   * committed order (the #1 integrity risk):
   *
   *   1. Lock the PG `carts` row FOR UPDATE (double-submit / concurrency guard).
   *   2. If `status='converted'` → 409 (already ordered — idempotent guard).
   *   3. Load the AUTHORITATIVE cart state (Redis-first blob, which alone carries the
   *      addresses / shipping / discount the PG row lacks) and validate it.
   *   4. Expand bundles: a line whose product `is_bundle` consumes its component variants
   *      × line qty (no-oversell enforced per component); its parent reservation is
   *      released so the placeholder stock is NOT decremented.
   *   5. Consume the (non-bundle) reservations inside the tx.
   *   6/7. Recompute discount + shipping + tax SERVER-SIDE (never trust the Redis totals)
   *      and snapshot the line items + addresses + owner B2B/VAT context.
   *   8. Allocate the order number from the per-tenant counter (may gap).
   *   9. Insert order (pending_payment) + items + initial status history; flip cart converted.
   *   10. Emit `order.created` AFTER commit.
   */
  async createFromCart(
    tenantId: string,
    cartId: string,
    actor: CreateFromCartActor = {},
  ): Promise<OrderWithGuestToken> {
    // Load the authoritative cart blob OUTSIDE the tx (Redis-first). The PG row lock
    // below is the concurrency arbiter; the blob carries the checkout details.
    const cart = await this.carts.findById(tenantId, cartId);
    if (!cart) {
      throw new NotFoundException(`Cart ${cartId} not found`);
    }

    // Guest order-lookup token: a per-order secret. We persist ONLY its sha256 hash;
    // the plaintext is attached to the returned order so /checkout can surface it exactly once.
    const guestAccessToken = randomBytes(32).toString('base64url');
    const guestTokenHash = createHash('sha256').update(guestAccessToken).digest('hex');

    const result = await this.db.db.transaction(async (tx) => {
      // 1. Lock the PG carts row FOR UPDATE — serialises concurrent checkouts.
      const locked = await this.orders.lockCartRowForUpdate(tx, tenantId, cartId);
      if (!locked) {
        // The cart blob exists in Redis but never flushed a PG row — shouldn't happen
        // (create() persists it eagerly), but treat as not-found rather than ordering.
        throw new NotFoundException(`Cart ${cartId} not found`);
      }
      // 2. Idempotent double-submit guard.
      if (locked.status === 'converted') {
        throw new ConflictException(`Cart ${cartId} has already been ordered`);
      }
      if (locked.status === 'abandoned') {
        throw new UnprocessableEntityException(`Cart ${cartId} is not orderable`);
      }

      // 3. Validate the cart — 422 on any missing requirement. NOTE:
      // this captures the cart's INTENT (did it select a shipping method?) BEFORE the
      // server-side recompute below can null a now-invalid rate — see the B4 re-check below.
      this.validateCheckoutReady(cart, actor);
      const requiredShippingMethod = Boolean(cart.shippingRateId);

      // 6/7. Recompute SERVER-SIDE inside the tx (DB-backed; never trust the Redis totals
      // blob). The discount engine is evaluated EXACTLY ONCE here: ALL of
      // {order discountAmount, per-line apportionment, discount_usages rows} derive from this
      // single `applied[]`, so a concurrent state flip between two evals can never let the
      // order keep a discount it didn't record as usage. Tax + shipping that depend on the
      // discount use the SAME result: discount → shipping → tax, all from this one pass.
      const discountEval = await this.discounts.evaluateForCart(tenantId, cart, cart.discountCode);
      const discountTotal = discountEval.discountTotal;
      // Stamp the discountTotal onto the cart BEFORE shipping + tax read it (shipping's
      // free_over base and tax's taxable base both derive from subtotal − discountTotal).
      cart.totals = { ...cart.totals, discountTotal, currency: cart.currency };

      // Re-resolve the SELECTED shipping rate: a free_over rate can flip and a
      // weight band can change; if the rate is no longer valid for the destination the
      // selection is cleared. Must run BEFORE tax (tax includes shipping as a component).
      if (cart.shippingRateId) {
        const cost = await this.shipping.resolveSelectedCost(tenantId, cart);
        if (cost === null) {
          cart.shippingRateId = null;
          cart.shippingAmount = 0;
        } else {
          cart.shippingAmount = cost;
        }
      } else {
        cart.shippingAmount = 0;
      }

      // BLOCKER 4 — the cart selected a shipping method that is no longer valid (vanished /
      // out-of-zone). validateCheckoutReady ran BEFORE the recompute, so it could not catch
      // this. Refuse with 422 rather than silently creating a 0-shipping order.
      if (requiredShippingMethod && !cart.shippingRateId) {
        throw new UnprocessableEntityException(
          'Cart is not ready: the selected shipping method is no longer available',
        );
      }

      // Resolve tax ONCE from the post-discount, post-shipping cart. The breakdown splits the
      // GOODS (items) tax + rate from the SHIPPING tax so shipping VAT is never
      // smeared into per-line goods tax.
      const taxResult = await this.taxes.resolveForCart(tenantId, cart);

      // Only discounts that actually contributed a saving consume a redemption.
      const appliedDiscounts = discountEval.applied.filter((a) => a.amount > 0);

      const { pricesIncludeTax: taxInclusive } = await this.tenantSettings.getTaxSettings(tenantId);
      // Pass taxInclusive so a zero-rated inclusive order (reverse charge / export) books the
      // NET total — the resolver stripped the embedded VAT into each line's base.
      const taxBreakdown = taxBreakdownFromResult(taxResult, taxInclusive);

      // Load catalogue metadata for every cart-line variant (title/sku/price/is_bundle).
      const variantIds = cart.items.map((i) => i.variantId);
      const meta = await this.orders.loadVariantsForSnapshot(tx, tenantId, variantIds);
      for (const variantId of variantIds) {
        if (!meta.has(variantId)) {
          // A line variant vanished from the catalogue between cart and checkout.
          throw new UnprocessableEntityException(`Variant ${variantId} is no longer available`);
        }
      }

      // 4. Bundle expansion + 5. consume stock — PER SNAPSHOT LINE, all inside the tx.
      // We do NOT flip whatever 'reserved' rows happen to exist (a swept / expired reservation
      // would zero-decrement or oversell). For each line we lock the variant, re-check PHYSICAL stock
      // covers the ordered qty (else 409), decrement, and reconcile this cart's reservation row —
      // see InventoryService.consumeLineInTx.
      //
      // Lock-acquisition order: iterate the lines sorted by variantId ASCENDING (and, for
      // bundles, their components ascending too). Two concurrent checkouts that touch
      // overlapping variants in opposite cart-insertion order would otherwise take the
      // variant FOR UPDATE locks in opposite order and deadlock (Postgres kills one → 500).
      // A single deterministic global order makes that impossible. This changes ONLY the
      // order locks are taken — not WHAT is consumed, nor the snapshot/totals (those derive
      // from the unsorted cart.items below).
      const linesByVariant = [...cart.items].sort((a, b) =>
        a.variantId < b.variantId ? -1 : a.variantId > b.variantId ? 1 : 0,
      );
      // B2 — collect any availability flip (positive → 0) the consume produces; emitted POST-COMMIT
      // below so a module only OBSERVES the depletion (it never enters this checkout transaction).
      const stockFlips: StockFlip[] = [];
      for (const item of linesByVariant) {
        const m = meta.get(item.variantId)!;
        if (m.isBundle) {
          const components = await this.orders.loadBundleComponents(tx, tenantId, m.productId);
          if (components.length === 0) {
            throw new UnprocessableEntityException(
              `Bundle ${m.productTitle} has no components configured`,
            );
          }
          // The placeholder parent reservation must NOT decrement parent stock — drop it,
          // then consume each constituent × line qty (no-oversell enforced per component
          // against PHYSICAL stock, independent of any swept reservation). Components are
          // consumed in ascending variantId order for the same deadlock-avoidance reason.
          await this.inventory.releaseInTx(tx, tenantId, cartId, item.variantId);
          const componentsByVariant = [...components].sort((a, b) =>
            a.variantId < b.variantId ? -1 : a.variantId > b.variantId ? 1 : 0,
          );
          for (const c of componentsByVariant) {
            const flip = await this.inventory.consumeBundleComponent(
              tx,
              tenantId,
              c.variantId,
              c.quantity * item.quantity,
            );
            if (flip) stockFlips.push(flip);
          }
        } else {
          // Non-bundle line: locked availability re-check + decrement against physical stock,
          // independent of whether a 'reserved' row still exists (it may have been swept).
          const flip = await this.inventory.consumeLineInTx(
            tx,
            tenantId,
            cartId,
            item.variantId,
            item.quantity,
          );
          if (flip) stockFlips.push(flip);
        }
      }

      // 6. Snapshot the PRICED order lines (only the bundle PARENT line is priced; its
      // components were consumed for stock but do not become priced order_items — that
      // would double-count the bundle price). Build the reconciled totals server-side.
      const snapshotInputs: SnapshotLineInput[] = cart.items.map((item) => {
        const m = meta.get(item.variantId)!;
        return {
          variantId: item.variantId,
          productTitle: m.productTitle,
          variantTitle: m.variantTitle,
          sku: m.sku,
          quantity: item.quantity,
          unitPriceAmount: item.unitPriceAmount,
          isBundleParent: m.isBundle,
        };
      });

      const { lines, totals } = buildSnapshot(
        snapshotInputs,
        discountTotal,
        taxBreakdown,
        cart.shippingAmount,
        taxInclusive,
      );

      // Owner B2B/VAT context for the order snapshot (from the customer row).
      const ownerCtx = await this.loadOwnerContext(tx, tenantId, cart.customerId);
      // reverse-charge flag from the SAME tax result resolved above (no re-resolve).
      const reverseCharge = taxResult.lines.some((l) => l.reverseCharge === true);

      const email = (cart.customerId ? ownerCtx?.email : null) ?? cart.guestEmail!;
      const shippingMethodName = await this.resolveShippingMethodName(tenantId, cart);

      // 8. Allocate the per-tenant order number (may gap).
      const orderNumber = await this.orders.allocateOrderNumber(tx, tenantId);

      // 9. Insert order + items + initial status history; flip cart converted.
      const inserted = await this.orders.insertOrder(tx, {
        tenantId,
        orderNumber: String(orderNumber),
        cartId,
        customerId: cart.customerId,
        email,
        status: 'pending_payment',
        currency: cart.currency,
        subtotalAmount: totals.subtotalAmount,
        discountAmount: totals.discountAmount,
        shippingAmount: totals.shippingAmount,
        taxAmount: totals.taxAmount,
        totalAmount: totals.totalAmount,
        isB2b: ownerCtx?.isB2b ?? false,
        vatNumber: ownerCtx?.vatNumber ?? null,
        reverseCharge,
        viesConsultationRef: ownerCtx?.viesConsultationRef ?? null,
        taxInclusive,
        shippingAddress: cart.shippingAddress,
        billingAddress: cart.billingAddress ?? cart.shippingAddress,
        shippingMethod: shippingMethodName,
        discountCode: cart.discountCode,
        guestTokenHash,
        placedAt: new Date(),
      });

      await this.orders.insertOrderItems(
        tx,
        lines.map((l) => ({
          tenantId,
          orderId: inserted.id,
          variantId: l.variantId,
          productTitle: l.productTitle,
          variantTitle: l.variantTitle,
          sku: l.sku,
          quantity: l.quantity,
          unitPriceAmount: l.unitPriceAmount,
          taxRate: l.taxRate.toFixed(4),
          taxAmount: l.taxAmount,
          lineTotalAmount: l.lineTotalAmount,
        })),
      );

      await this.orders.insertStatusHistory(tx, {
        tenantId,
        orderId: inserted.id,
        fromStatus: null,
        toStatus: 'pending_payment',
        changedBy: null,
        note: 'Order created from cart',
      });

      // Consume discount redemptions inside the SAME tx — row-lock each
      // applied discount, RE-CHECK its limits against the live committed state, then
      // insert a discount_usages row + bump used_count. A limit now exhausted by a
      // concurrent order FAILS the whole checkout (409) so the tx rolls back and the
      // usage_limit_total can never be over-redeemed.
      await this.consumeDiscountUsages(
        tx,
        tenantId,
        inserted.id,
        cart.customerId,
        cart.guestEmail,
        appliedDiscounts,
      );

      const flipped = await this.orders.markCartConverted(tx, tenantId, cartId);
      if (!flipped) {
        // Defensive: the locked cart row vanished mid-tx (cannot happen under the lock).
        throw new ConflictException(`Cart ${cartId} could not be converted`);
      }

      return { inserted, stockFlips };
    });
    const { inserted: order, stockFlips } = result;

    // 10. Emit AFTER commit so a rolled-back tx can never fire a phantom event.
    this.events.emit(
      OrderCreatedEvent.EVENT_NAME,
      new OrderCreatedEvent(tenantId, order.id, cartId, order.customerId),
    );

    // B2 — emit product.stock_changed for any availability flip the checkout caused, POST-COMMIT.
    // Boolean-only (`available:false` on depletion); observational; a rolled-back tx fired nothing.
    this.emitStockFlips(tenantId, stockFlips);

    // Surface the plaintext token ONCE (runtime-only; never persisted, never logged).
    return Object.assign(order, { guestAccessToken });
  }

  /**
   * Idempotent "load-or-create" used by the payment-intent endpoint. A
   * payment-intent request must yield exactly ONE order per cart even on retries / double
   * clicks: the cart converts on first call, and a second call must REUSE that order rather
   * than erroring (unlike the public `/checkout`, which 409s on a converted cart).
   *
   * Fast path: the cart already has an order → return it. Otherwise create it; if a CONCURRENT
   * request converted the cart first (createFromCart throws 409), resolve to the order that
   * request created. `createFromCart` itself stays unchanged (single creation point, single tx).
   */
  async createOrLoadFromCart(
    tenantId: string,
    cartId: string,
    actor: CreateFromCartActor = {},
  ): Promise<Order> {
    const existing = await this.orders.findByCartId(tenantId, cartId);
    if (existing) return existing;
    try {
      return await this.createFromCart(tenantId, cartId, actor);
    } catch (err) {
      // A concurrent payment-intent request converted the cart between our check and our
      // lock — its order is now the canonical one for this cart. Resolve to it.
      if (err instanceof ConflictException) {
        const order = await this.orders.findByCartId(tenantId, cartId);
        if (order) return order;
      }
      throw err;
    }
  }

  /**
   * Drive one legal status transition for a tenant-scoped order.
   *
   * @throws NotFoundException (404) if the order is missing/soft-deleted in this tenant.
   * @throws UnprocessableEntityException (422) if `from → to` is not a legal edge.
   * @returns the updated order row.
   */
  async transition(
    tenantId: string,
    orderId: string,
    to: OrderStatus,
    ctx: TransitionContext = {},
  ): Promise<Order> {
    const { updated, from } = await this.db.db.transaction(async (tx) => {
      // 1. Load + lock the order (FOR UPDATE) — serialises concurrent transitions.
      const current = await this.orders.findByIdForUpdate(tx, tenantId, orderId);
      if (!current) {
        throw new NotFoundException(`Order ${orderId} not found`);
      }
      const fromStatus = current.status as OrderStatus;

      // 1b. Optimistic-from guard: refuse if the order moved off the status the
      // caller expected (e.g. a payment landed between the sweeper's scan and this cancel).
      if (ctx.expectedFrom && fromStatus !== ctx.expectedFrom) {
        throw new ConflictException(
          `Order ${orderId} is ${fromStatus}, not ${ctx.expectedFrom}; transition skipped`,
        );
      }

      // 2. Validate the edge (422 on an illegal transition — terminal/self/unknown).
      assertTransition(fromStatus, to);

      // 2a. Optional in-tx precondition: atomic re-check under the lock
      // (e.g. refuse to cancel/mark-paid an order whose SEPA is mid-clearing). Throws → rollback.
      if (ctx.precondition) {
        await ctx.precondition(tx);
      }

      // 2b. Fulfillment freeze: a disputed order must not ship. While
      // `fulfillment_frozen`, refuse the fulfillment-advancing edges (→ fulfilled / → shipped).
      // Refunds/cancellation stay allowed (a lost dispute still needs the order to resolve).
      if (current.fulfillmentFrozen && (to === 'fulfilled' || to === 'shipped')) {
        throw new UnprocessableEntityException(
          `Order ${orderId} fulfillment is frozen (open dispute) and cannot move to ${to}`,
        );
      }

      // 3. Update status.
      const row = await this.orders.updateStatus(tx, tenantId, orderId, to);
      if (!row) {
        // Defensive: the FOR-UPDATE row vanished between lock and update (should not
        // happen under the lock). Treat as not-found rather than emitting an event.
        throw new NotFoundException(`Order ${orderId} not found`);
      }

      // 4. Append the append-only history row.
      await this.orders.insertStatusHistory(tx, {
        tenantId,
        orderId,
        fromStatus,
        toStatus: to,
        changedBy: ctx.changedBy ?? null,
        note: ctx.note ?? null,
      });

      return { updated: row, from: fromStatus };
    });

    // 5. Emit AFTER commit so a rolled-back tx can't fire a phantom event.
    this.events.emit(
      OrderStatusChangedEvent.eventName(to),
      new OrderStatusChangedEvent(tenantId, orderId, from, to, ctx.changedBy ?? null),
    );

    return updated;
  }

  // ── Reads ────────────────────────────────────────────────────────────────────

  /** Admin: a tenant-scoped, offset-paginated order list. */
  async adminList(tenantId: string, filters: OrderListFilters): Promise<OrderListResult> {
    return this.orders.listForTenant(tenantId, filters);
  }

  /**
   * Admin: a tenant-scoped order with its line items + status history.
   * @throws NotFoundException (404) when the order is missing/deleted in this tenant.
   */
  async adminDetail(
    tenantId: string,
    orderId: string,
  ): Promise<{ order: Order; items: OrderItem[]; history: OrderStatusHistory[] }> {
    const order = await this.orders.findById(tenantId, orderId);
    if (!order) throw new NotFoundException(`Order ${orderId} not found`);
    const [items, history] = await Promise.all([
      this.orders.itemsForOrder(tenantId, orderId),
      this.orders.historyForOrder(tenantId, orderId),
    ]);
    return { order, items, history };
  }

  /** Store: the authenticated customer's own orders (newest first). Tenant-scoped. */
  async listForCustomer(tenantId: string, customerId: string): Promise<Order[]> {
    return this.orders.listForCustomer(tenantId, customerId);
  }

  /**
   * Store: ONE of the customer's OWN orders, with items. No IDOR — an order id that
   * belongs to another customer (or a guest order) does NOT match and 404s.
   * @throws NotFoundException (404) when the order is not this customer's.
   */
  async findForCustomer(
    tenantId: string,
    customerId: string,
    orderId: string,
  ): Promise<{ order: Order; items: OrderItem[] }> {
    const order = await this.orders.findByIdForCustomer(tenantId, orderId, customerId);
    if (!order) throw new NotFoundException(`Order ${orderId} not found`);
    const items = await this.orders.itemsForOrder(tenantId, orderId);
    return { order, items };
  }

  /**
   * Store: a GUEST order lookup by order number + per-order token. No IDOR /
   * enumeration — an unknown number, a tokenless order, or a wrong token ALL throw the SAME 404
   * (the controller never distinguishes them). The token is compared in CONSTANT TIME against the
   * stored sha256 hash. Tenant-scoped.
   */
  async findForGuest(
    tenantId: string,
    orderNumber: string,
    token: string | undefined,
  ): Promise<{ order: Order; items: OrderItem[] }> {
    const notFound = () => new NotFoundException('Order not found');
    const order = await this.orders.findByOrderNumber(tenantId, orderNumber);
    if (!order || !order.guestTokenHash || !token) throw notFound();
    const provided = createHash('sha256').update(token).digest();
    const stored = Buffer.from(order.guestTokenHash, 'hex');
    if (provided.length !== stored.length || !timingSafeEqual(provided, stored)) throw notFound();
    const items = await this.orders.itemsForOrder(tenantId, order.id);
    return { order, items };
  }

  // ── createFromCart private helpers ────────────────────────────────────────────

  /**
   * Validate the cart is checkout-ready — 422 on any missing requirement.
   * NO payment precondition (orders are born `pending_payment`).
   */
  private validateCheckoutReady(cart: CartState, actor: CreateFromCartActor): void {
    if (cart.items.length === 0) {
      throw new UnprocessableEntityException('Cannot checkout an empty cart');
    }
    if (!cart.shippingAddress) {
      throw new UnprocessableEntityException('A shipping address is required to checkout');
    }
    if (!cart.shippingRateId) {
      throw new UnprocessableEntityException('A shipping method is required to checkout');
    }
    // A customer (cart owner or authenticated actor) OR a guest email must identify the buyer.
    const hasCustomer = Boolean(cart.customerId ?? actor.customer?.id);
    if (!hasCustomer && !cart.guestEmail) {
      throw new UnprocessableEntityException('A customer or guest email is required to checkout');
    }
  }

  /**
   * B2 — emit `product.stock_changed` for each availability flip a committed stock mutation caused.
   * Called POST-COMMIT only, so a rolled-back checkout fires nothing. Boolean-only payload — the
   * exact stock level is never exposed. A subscribed module merely OBSERVES the transition.
   *
   * Best-effort: the whole fan-out is try/caught so a bus-dispatch error can NEVER turn an
   * already-committed checkout into a 500 (the order stands; the missed signal is logged).
   */
  private emitStockFlips(tenantId: string, flips: readonly StockFlip[]): void {
    try {
      for (const f of flips) {
        this.events.emit(
          ProductStockChangedEvent.EVENT,
          new ProductStockChangedEvent(tenantId, f.productId, f.variantId, f.available),
        );
      }
    } catch (err) {
      this.logger.error('B2 product.stock_changed emit failed (order already committed)', err);
    }
  }

  /**
   * Load the cart owner's order-snapshot context (email + B2B/VAT) from the customers
   * table, tenant-scoped. Null for a guest cart. Runs in the order tx.
   */
  private async loadOwnerContext(
    tx: Parameters<Parameters<DatabaseService['db']['transaction']>[0]>[0],
    tenantId: string,
    customerId: string | null,
  ): Promise<{
    email: string;
    isB2b: boolean;
    vatNumber: string | null;
    viesConsultationRef: string | null;
  } | null> {
    if (!customerId) return null;
    const [row] = await tx
      .select({
        email: customers.email,
        isB2b: customers.isB2b,
        vatNumber: customers.vatNumber,
        metadata: customers.metadata,
      })
      .from(customers)
      .where(and(eq(customers.id, customerId), eq(customers.tenantId, tenantId)))
      .limit(1);
    if (!row) return null;
    return {
      email: row.email,
      isB2b: row.isB2b,
      vatNumber: row.vatNumber,
      // VIES order-time snapshot: capture the consultation ref from the
      // customer's CURRENTLY-VALID VAT proof. The number match is implicit (we read the same row
      // whose vat_number we snapshot). The invoice reads THIS column so its reverse-charge evidence
      // is stable. Null unless a live `valid` proof.
      viesConsultationRef: extractValidViesRef(row.metadata),
    };
  }

  /**
   * Consume the applied discounts' redemptions inside the order tx (MONEY-CRITICAL block
   * guarding against usage-limit over-redemption under concurrency):
   *
   *  1. Row-LOCK every applied discount `FOR UPDATE` — the serialization point. Two
   *     concurrent checkouts redeeming the same discount block here; the second reads the
   *     first's COMMITTED used_count.
   *  2. RE-CHECK `usage_limit_total` against the live used_count and, for a known customer,
   *     `usage_limit_per_customer` against the committed prior usages. If a limit is now
   *     exhausted (a concurrent order took the last redemption), throw 409 → the whole
   *     order tx rolls back and totals never desync.
   *  3. Insert ONE discount_usages row per applied discount (id, amount, customer-or-null)
   *     and increment used_count — keeping `used_count == count(discount_usages)`.
   */
  private async consumeDiscountUsages(
    tx: Parameters<Parameters<DatabaseService['db']['transaction']>[0]>[0],
    tenantId: string,
    orderId: string,
    customerId: string | null,
    guestEmail: string | null,
    applied: AppliedDiscount[],
  ): Promise<void> {
    if (applied.length === 0) return;

    // Normalized guest email — the per-customer dedup key for a guest checkout
    // (customer_id NULL). Persisted on every usage row for a stable redemption record.
    const normalizedEmail = guestEmail ? guestEmail.toLowerCase() : null;

    // 1. Lock all applied discount rows (stable id order avoids lock-ordering deadlocks).
    const ids = applied.map((a) => a.discountId);
    const locked = await this.orders.lockDiscountsForUpdate(tx, tenantId, ids);

    for (const a of applied) {
      const row = locked.get(a.discountId);
      if (!row) {
        // The discount vanished between cart-eval and the lock (deleted mid-checkout).
        throw new ConflictException('Discount is no longer available');
      }

      // 2a. Re-check the TOTAL usage limit against the live committed used_count.
      if (row.usageLimitTotal != null && row.usedCount >= row.usageLimitTotal) {
        throw new ConflictException('Discount is no longer available');
      }

      // 2b. Re-check the PER-CUSTOMER limit. For a logged-in customer this is keyed on
      // customer_id; for a GUEST it is keyed on the normalized email so the limit can't
      // be bypassed by checking out as a guest. FAIL CLOSED if a guest presents no email
      // (treat the limit as reached) rather than skipping the check entirely.
      if (row.usageLimitPerCustomer != null) {
        if (customerId) {
          const prior = await this.orders.countCustomerDiscountUsages(
            tx,
            tenantId,
            a.discountId,
            customerId,
          );
          if (prior >= row.usageLimitPerCustomer) {
            throw new ConflictException('Discount is no longer available');
          }
        } else if (normalizedEmail) {
          const prior = await this.orders.countGuestDiscountUsages(
            tx,
            tenantId,
            a.discountId,
            normalizedEmail,
          );
          if (prior >= row.usageLimitPerCustomer) {
            throw new ConflictException('Discount is no longer available');
          }
        } else {
          // No customer AND no email: cannot dedup → fail closed.
          throw new ConflictException('Discount is no longer available');
        }
      }

      // 3. Record the redemption + bump the counter, both in this tx.
      await this.orders.insertDiscountUsage(tx, {
        tenantId,
        discountId: a.discountId,
        orderId,
        customerId,
        email: normalizedEmail,
        amount: a.amount,
      });
      await this.orders.bumpUsedCount(tx, tenantId, a.discountId);
    }
  }

  /** The human-readable name of the cart's selected shipping rate, for the order snapshot. */
  private async resolveShippingMethodName(
    tenantId: string,
    cart: CartState,
  ): Promise<string | null> {
    if (!cart.shippingRateId) return null;
    const rates = await this.shipping.availableRates(tenantId, cart);
    return rates.find((r) => r.id === cart.shippingRateId)?.name ?? null;
  }
}

/**
 * Split a {@link TaxResult} into the order-snapshot {@link TaxBreakdown}: the
 * tax engine emits an "Items" component (goods, apportioned across order_items) and a separate
 * "Shipping" component (kept order-level). `itemsRate` is the STATUTORY destination rate (a
 * fraction) — what `order_items.tax_rate` stores, never a blended ratio that could overflow.
 * Any non-shipping line counts toward items; the statutory rate is taken from the items line
 * (all components share one destination rate in v1, so this is unambiguous).
 */
/**
 * Extract a customer's VIES consultation reference from their durable VAT proof,
 * but ONLY when the proof is currently `status === 'valid'`
 * (mirrors InvoiceRepository.loadCustomerViesRef's status guard). A cache-hit proof carries no
 * per-consultation ref (and no status === 'valid' with a ref). Returns null otherwise.
 */
export function extractValidViesRef(metadata: unknown): string | null {
  if (typeof metadata !== 'object' || metadata === null) return null;
  const vat = (metadata as Record<string, unknown>).vat;
  if (typeof vat !== 'object' || vat === null) return null;
  const vatRec = vat as Record<string, unknown>;
  if (vatRec.status !== 'valid') return null;
  return typeof vatRec.consultationRef === 'string' ? vatRec.consultationRef : null;
}

export function taxBreakdownFromResult(result: TaxResult, taxInclusive = false): TaxBreakdown {
  let itemsTax = 0;
  let shippingTax = 0;
  let itemsRate = 0;
  // tax-INCLUSIVE zero-rated lines (B2B reverse charge / non-EU export): the resolver
  // re-derived a NET base (embedded VAT stripped) on lines with rate 0 / amount 0. Sum those
  // nets so the snapshot books the NET total, not the gross. Only meaningful when taxInclusive.
  let inclusiveItemsNet: number | undefined;
  let inclusiveShippingNet: number | undefined;
  for (const line of result.lines) {
    const isZeroRated = line.rate === 0 && line.amount === 0;
    if (line.description === 'Shipping') {
      shippingTax += line.amount;
      if (taxInclusive && isZeroRated) {
        inclusiveShippingNet = (inclusiveShippingNet ?? 0) + line.base;
      }
    } else {
      itemsTax += line.amount;
      // The statutory rate from the items component (reverse charge / no-VAT → 0).
      if (line.rate > 0) itemsRate = line.rate;
      if (taxInclusive && isZeroRated) {
        inclusiveItemsNet = (inclusiveItemsNet ?? 0) + line.base;
      }
    }
  }
  return { itemsTax, itemsRate, shippingTax, inclusiveItemsNet, inclusiveShippingNet };
}
