/**
 * InventoryService (NO-OVERSELL engine).
 *
 * Stock reservations are mediated by Postgres row locks: every reserve() runs in
 * one short transaction that takes `SELECT … FOR UPDATE` on the variant row,
 * which serialises ALL concurrent reservations for that variant. Availability is
 * computed as `stock_quantity − Σ(other carts' active reservations)`; an over-ask
 * without backorder throws InsufficientStockException (HTTP 409). This is the
 * simplest correct design — the row lock alone makes the 100-concurrent
 * "exactly one wins" test pass by serialisation.
 *
 * `stock_quantity` is only decremented at consume() (order placement). Until
 * then, reservations hold the units logically; expired reservations stop
 * counting immediately (the availability query filters `expires_at > now()`),
 * so a lagging sweeper can never cause oversell.
 *
 * Every query is tenant-scoped. Money/stock are integers.
 */
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, asc, eq, lt, ne, sql } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { productVariants } from '../database/schema/product_variants';
import { inventoryReservations } from '../database/schema/inventory_reservations';
import { InsufficientStockException } from './insufficient-stock.exception';
import { availabilityFlip } from './availability';

/**
 * An AVAILABILITY flip a stock mutation produced, returned by the in-tx consume/
 * restock methods so the CALLER can emit `product.stock_changed` POST-COMMIT (observational; a
 * module never enters the transactional path). `available` is the new state after the flip:
 * `true` on out-of-stock → in-stock (0 → positive), `false` on in-stock → out-of-stock. A mutation
 * that did not cross the zero boundary returns `null` (no flip → no event). NEVER carries the level.
 */
export interface StockFlip {
  readonly variantId: string;
  readonly productId: string;
  readonly available: boolean;
}

/** Default reservation TTL when INVENTORY_RESERVATION_TTL_MINUTES is unset. */
const DEFAULT_TTL_MINUTES = 15;

/** The transaction handle drizzle passes to a `.transaction(async (tx) => …)` callback. */
type Tx = Parameters<Parameters<DatabaseService['db']['transaction']>[0]>[0];

@Injectable()
export class InventoryService {
  private readonly logger = new Logger(InventoryService.name);

  constructor(private readonly db: DatabaseService) {}

  /** Configured reservation lifetime in minutes (default 15). */
  private get ttlMinutes(): number {
    const raw = Number(process.env.INVENTORY_RESERVATION_TTL_MINUTES);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TTL_MINUTES;
  }

  private expiryFromNow(): Date {
    return new Date(Date.now() + this.ttlMinutes * 60 * 1000);
  }

  /**
   * Reserve `quantity` units of a variant for a cart. Idempotent per (cart,
   * variant): the reservation is SET to the absolute quantity (add / update /
   * re-add all collapse to "this cart holds Q").
   *
   * @returns the quantity actually reserved (== requested, unless clamped).
   * @throws  NotFoundException        if the variant is missing in this tenant.
   * @throws  InsufficientStockException (409) if over available & no backorder
   *          & not clamping.
   */
  async reserve(
    tenantId: string,
    cartId: string,
    variantId: string,
    quantity: number,
    opts: { clampToAvailable?: boolean } = {},
  ): Promise<number> {
    return this.db.db.transaction(async (tx) => {
      // 1. Row-lock the variant — serialises every concurrent reservation for it.
      const [variant] = await tx
        .select({
          stockQuantity: productVariants.stockQuantity,
          allowBackorder: productVariants.allowBackorder,
        })
        .from(productVariants)
        .where(and(eq(productVariants.id, variantId), eq(productVariants.tenantId, tenantId)))
        .for('update')
        .limit(1);

      if (!variant) {
        throw new NotFoundException(`Variant ${variantId} not found`);
      }

      // 2. Σ quantity of OTHER carts' active (reserved, unexpired) reservations.
      const otherRows = await tx
        .select({ sum: sql<number>`coalesce(sum(${inventoryReservations.quantity}), 0)::int` })
        .from(inventoryReservations)
        .where(
          and(
            eq(inventoryReservations.variantId, variantId),
            eq(inventoryReservations.tenantId, tenantId),
            eq(inventoryReservations.status, 'reserved'),
            sql`${inventoryReservations.expiresAt} > now()`,
            ne(inventoryReservations.cartId, cartId),
          ),
        );

      const available = variant.stockQuantity - Number(otherRows[0]?.sum ?? 0);

      // 3. Enforce availability (backorder never clamps; qty stays as asked).
      let qty = quantity;
      if (!variant.allowBackorder && qty > available) {
        if (opts.clampToAvailable) {
          qty = Math.max(available, 0);
        } else {
          throw new InsufficientStockException(variantId, quantity, Math.max(available, 0));
        }
      }

      // 4a. Nothing left → drop any existing reservation, hold nothing.
      if (qty <= 0) {
        await this.deleteReservation(tx, tenantId, cartId, variantId);
        return 0;
      }

      // 4b. Manual upsert (the variant row-lock serialises us, so no unique
      // constraint / ON CONFLICT is needed — and none exists on the table).
      const [existing] = await tx
        .select({ id: inventoryReservations.id })
        .from(inventoryReservations)
        .where(
          and(
            eq(inventoryReservations.cartId, cartId),
            eq(inventoryReservations.variantId, variantId),
            eq(inventoryReservations.tenantId, tenantId),
          ),
        )
        .limit(1);

      const expiresAt = this.expiryFromNow();
      if (existing) {
        await tx
          .update(inventoryReservations)
          .set({ quantity: qty, status: 'reserved', expiresAt })
          .where(eq(inventoryReservations.id, existing.id));
      } else {
        await tx
          .insert(inventoryReservations)
          .values({ tenantId, cartId, variantId, quantity: qty, status: 'reserved', expiresAt });
      }

      return qty;
    });
  }

  /** Release a single (cart, variant) reservation (item removed from cart). */
  async release(tenantId: string, cartId: string, variantId: string): Promise<void> {
    await this.deleteReservation(this.db.db, tenantId, cartId, variantId);
  }

  /**
   * Delete a single (cart, variant) reservation INSIDE the caller's tx. Used by order
   * creation to drop a bundle PARENT variant's reservation before consume() runs — the
   * parent is a placeholder whose stock must NOT be decremented; only its constituent
   * components are consumed. Atomic with the surrounding order tx.
   */
  async releaseInTx(tx: Tx, tenantId: string, cartId: string, variantId: string): Promise<void> {
    await this.deleteReservation(tx, tenantId, cartId, variantId);
  }

  /**
   * Reconcile a cart's reservations to EXACTLY match `items` (phantom-reservation
   * compensation). When CartRepository.mutate() exhausts its retry budget AFTER a reserve()
   * already committed an absolute qty, the un-committed Redis blob no longer reflects that PG
   * hold → an orphan reservation counts against other carts until TTL. This re-aligns PG to the
   * authoritative LAST-READ cart state: each listed item is re-reserved (CLAMPED to availability
   * so it never throws and never over-reserves — the no-oversell-safe direction), and any
   * reservation rows for variants NOT in the list are released.
   *
   * Clamping can only LOWER a hold (frees units for others), never raise it past availability,
   * so the no-oversell invariant is preserved. Best-effort: a per-item failure is logged and
   * skipped rather than masking the original conflict.
   */
  async reconcileCartReservations(
    tenantId: string,
    cartId: string,
    items: Array<{ variantId: string; quantity: number }>,
  ): Promise<void> {
    const wanted = new Map<string, number>();
    for (const it of items) {
      // Collapse duplicate variant lines to a single absolute qty (reserve is absolute).
      wanted.set(it.variantId, (wanted.get(it.variantId) ?? 0) + it.quantity);
    }

    // 1. Release reservations for variants no longer present in the authoritative cart.
    const current = await this.db.db
      .select({ variantId: inventoryReservations.variantId })
      .from(inventoryReservations)
      .where(
        and(eq(inventoryReservations.tenantId, tenantId), eq(inventoryReservations.cartId, cartId)),
      );
    for (const row of current) {
      if (!wanted.has(row.variantId)) {
        await this.deleteReservation(this.db.db, tenantId, cartId, row.variantId).catch((err) =>
          this.logger.warn(
            `reconcile release failed (cart ${cartId}, variant ${row.variantId}): ${
              err instanceof Error ? err.message : 'unknown'
            }`,
          ),
        );
      }
    }

    // 2. Re-reserve each wanted item to its absolute qty, clamped (never throws / over-reserves).
    for (const [variantId, quantity] of wanted) {
      await this.reserve(tenantId, cartId, variantId, quantity, { clampToAvailable: true }).catch(
        (err) =>
          this.logger.warn(
            `reconcile reserve failed (cart ${cartId}, variant ${variantId}): ${
              err instanceof Error ? err.message : 'unknown'
            }`,
          ),
      );
    }
  }

  /** Release every reservation held by a cart (cart abandoned / merged away). */
  async releaseForCart(tenantId: string, cartId: string): Promise<void> {
    await this.db.db
      .delete(inventoryReservations)
      .where(
        and(eq(inventoryReservations.tenantId, tenantId), eq(inventoryReservations.cartId, cartId)),
      );
  }

  /**
   * Consume ONE order line's stock directly inside the caller's order tx.
   * The old `consume()` flipped whatever `reserved` rows existed to
   * confirmed with NO expiry filter and NO check that they actually cover the ordered qty:
   * a cart idle past the TTL (its reservation swept) decremented ZERO; an expired-but-unswept
   * reservation decremented units already re-promised to another cart → negative stock.
   *
   * This mirrors {@link consumeBundleComponent}: it does NOT trust a `reserved` row existing.
   * For (variant V, qty Q) it locks V FOR UPDATE, verifies the PHYSICAL `stock_quantity ≥ Q`
   * (else 409 InsufficientStockException — backorder variants skip the check), decrements
   * `stock_quantity` by Q, and reconciles THIS cart's reservation row (flips it `confirmed`
   * if present so availability accounting stays consistent — a confirmed row never counts as
   * an active hold, and the now-decremented physical stock already reflects the sale, so the
   * units are neither double-counted as available nor as a hold). Idempotent-safe under the
   * cart FOR UPDATE lock the order tx already holds.
   *
   * @throws NotFoundException        if the variant is missing in this tenant.
   * @throws InsufficientStockException (409) if `quantity` exceeds physical stock and the
   *   variant does not allow backorder ('insufficient stock at checkout').
   */
  async consumeLineInTx(
    tx: Tx,
    tenantId: string,
    cartId: string,
    variantId: string,
    quantity: number,
  ): Promise<StockFlip | null> {
    // 1. Row-lock the variant — serialises every concurrent consumer/reserver of it.
    const [variant] = await tx
      .select({
        productId: productVariants.productId,
        stockQuantity: productVariants.stockQuantity,
        allowBackorder: productVariants.allowBackorder,
      })
      .from(productVariants)
      .where(and(eq(productVariants.id, variantId), eq(productVariants.tenantId, tenantId)))
      .for('update')
      .limit(1);
    if (!variant) {
      throw new NotFoundException(`Variant ${variantId} not found`);
    }

    // No-oversell: physical stock must cover the ordered qty (NOT a 'reserved' row that
    // may have been swept). Backorder variants are allowed to go negative-as-debt.
    if (!variant.allowBackorder && quantity > variant.stockQuantity) {
      throw new InsufficientStockException(variantId, quantity, Math.max(variant.stockQuantity, 0));
    }

    // 3. Decrement physical stock under the held lock; read back the new level for the flip check.
    const [after] = await tx
      .update(productVariants)
      .set({ stockQuantity: sql`${productVariants.stockQuantity} - ${quantity}` })
      .where(and(eq(productVariants.id, variantId), eq(productVariants.tenantId, tenantId)))
      .returning({ stockQuantity: productVariants.stockQuantity });

    // 4. Reconcile THIS cart's reservation on the variant (if any) → confirmed, so the
    // availability query (which only counts status='reserved' AND unexpired) stops counting
    // it as an active hold. A swept/missing reservation simply has nothing to reconcile.
    await tx
      .update(inventoryReservations)
      .set({ status: 'confirmed' })
      .where(
        and(
          eq(inventoryReservations.tenantId, tenantId),
          eq(inventoryReservations.cartId, cartId),
          eq(inventoryReservations.variantId, variantId),
          eq(inventoryReservations.status, 'reserved'),
        ),
      );

    // Report an availability flip (positive → 0 here) so the caller can emit post-commit.
    return this.flip(variantId, variant, after?.stockQuantity);
  }

  /**
   * Consume stock for a BUNDLE CONSTITUENT directly inside the caller's order tx.
   * The cart only holds a reservation on the bundle PARENT variant, never its components,
   * so there is no `reserved` row to flip here: we lock the component variant FOR UPDATE,
   * enforce no-oversell against OTHER carts' active reservations (the same availability
   * formula as reserve()), then decrement `stock_quantity`. Runs in the order tx so a
   * rollback un-decrements it.
   *
   * @throws NotFoundException        if the component variant is missing in this tenant.
   * @throws InsufficientStockException (409) if `quantity` exceeds availability and the
   *   variant does not allow backorder.
   */
  async consumeBundleComponent(
    tx: Tx,
    tenantId: string,
    variantId: string,
    quantity: number,
  ): Promise<StockFlip | null> {
    // 1. Row-lock the component variant — serialises concurrent consumers of it.
    const [variant] = await tx
      .select({
        productId: productVariants.productId,
        stockQuantity: productVariants.stockQuantity,
        allowBackorder: productVariants.allowBackorder,
      })
      .from(productVariants)
      .where(and(eq(productVariants.id, variantId), eq(productVariants.tenantId, tenantId)))
      .for('update')
      .limit(1);
    if (!variant) {
      throw new NotFoundException(`Variant ${variantId} not found`);
    }

    // 2. Availability = stock − Σ(ALL carts' active reservations on this component).
    // A bundle parent is a DISTINCT variant, so the cart holds no reservation on the
    // component; every active reservation here is a genuine competing hold.
    const [reserved] = await tx
      .select({ sum: sql<number>`coalesce(sum(${inventoryReservations.quantity}), 0)::int` })
      .from(inventoryReservations)
      .where(
        and(
          eq(inventoryReservations.variantId, variantId),
          eq(inventoryReservations.tenantId, tenantId),
          eq(inventoryReservations.status, 'reserved'),
          sql`${inventoryReservations.expiresAt} > now()`,
        ),
      );
    const available = variant.stockQuantity - Number(reserved?.sum ?? 0);

    if (!variant.allowBackorder && quantity > available) {
      throw new InsufficientStockException(variantId, quantity, Math.max(available, 0));
    }

    // 3. Decrement the component's stock under the held row lock; read back for the flip check.
    const [after] = await tx
      .update(productVariants)
      .set({ stockQuantity: sql`${productVariants.stockQuantity} - ${quantity}` })
      .where(and(eq(productVariants.id, variantId), eq(productVariants.tenantId, tenantId)))
      .returning({ stockQuantity: productVariants.stockQuantity });

    // Report an availability flip (positive → 0) for post-commit emission by the caller.
    return this.flip(variantId, variant, after?.stockQuantity);
  }

  /**
   * Restore (increment) a variant's physical stock inside the caller's tx — the INVERSE of
   * {@link consumeLineInTx} / {@link consumeBundleComponent}. Used when an unpaid order is
   * cancelled to release the stock consumed at order creation.
   *
   * Locks the variant FOR UPDATE then increments `stock_quantity` by `quantity`. TOLERANT of a
   * since-deleted variant: a missing row is logged and skipped (best-effort restock — there is
   * no stock row left to credit) rather than aborting the whole cancellation's restock.
   */
  async restockInTx(
    tx: Tx,
    tenantId: string,
    variantId: string,
    quantity: number,
  ): Promise<StockFlip | null> {
    if (quantity <= 0) return null;
    const [variant] = await tx
      .select({
        productId: productVariants.productId,
        stockQuantity: productVariants.stockQuantity,
        allowBackorder: productVariants.allowBackorder,
      })
      .from(productVariants)
      .where(and(eq(productVariants.id, variantId), eq(productVariants.tenantId, tenantId)))
      .for('update')
      .limit(1);
    if (!variant) {
      this.logger.warn(`restock skipped — variant ${variantId} no longer exists`);
      return null;
    }
    const [after] = await tx
      .update(productVariants)
      .set({ stockQuantity: sql`${productVariants.stockQuantity} + ${quantity}` })
      .where(and(eq(productVariants.id, variantId), eq(productVariants.tenantId, tenantId)))
      .returning({ stockQuantity: productVariants.stockQuantity });

    // Report an availability flip (0 → positive on restock) for post-commit emission.
    return this.flip(variantId, variant, after?.stockQuantity);
  }

  /**
   * Build a {@link StockFlip} for a variant whose stock went `before` → `after`, or `null` when
   * availability did not cross zero. `after` may be undefined (no row returned) → no flip. Shared by
   * the consume/restock paths so they all agree on what an availability flip is.
   */
  private flip(
    variantId: string,
    variant: { productId: string; stockQuantity: number; allowBackorder: boolean },
    afterStock: number | undefined,
  ): StockFlip | null {
    if (afterStock === undefined) return null;
    const available = availabilityFlip(variant.stockQuantity, afterStock, variant.allowBackorder);
    if (available === null) return null;
    return { variantId, productId: variant.productId, available };
  }

  /**
   * Available units for a variant: stock_quantity minus the sum of ALL carts'
   * active (reserved, unexpired) reservations. Used by the admin view / future
   * storefront availability display.
   */
  async availableStock(tenantId: string, variantId: string): Promise<number> {
    const [variant] = await this.db.db
      .select({ stockQuantity: productVariants.stockQuantity })
      .from(productVariants)
      .where(and(eq(productVariants.id, variantId), eq(productVariants.tenantId, tenantId)))
      .limit(1);
    if (!variant) {
      throw new NotFoundException(`Variant ${variantId} not found`);
    }

    const reservedRows = await this.db.db
      .select({ sum: sql<number>`coalesce(sum(${inventoryReservations.quantity}), 0)::int` })
      .from(inventoryReservations)
      .where(
        and(
          eq(inventoryReservations.variantId, variantId),
          eq(inventoryReservations.tenantId, tenantId),
          eq(inventoryReservations.status, 'reserved'),
          sql`${inventoryReservations.expiresAt} > now()`,
        ),
      );

    return variant.stockQuantity - Number(reservedRows[0]?.sum ?? 0);
  }

  /** List a tenant's reservations (admin debug), optionally filtered by variant. */
  async listReservations(
    tenantId: string,
    variantId?: string,
  ): Promise<(typeof inventoryReservations.$inferSelect)[]> {
    const where = variantId
      ? and(
          eq(inventoryReservations.tenantId, tenantId),
          eq(inventoryReservations.variantId, variantId),
        )
      : eq(inventoryReservations.tenantId, tenantId);

    return this.db.db
      .select()
      .from(inventoryReservations)
      .where(where)
      .orderBy(asc(inventoryReservations.expiresAt));
  }

  /** Delete expired 'reserved' rows (sweeper housekeeping). Returns the count. */
  async deleteExpired(): Promise<number> {
    const deleted = await this.db.db
      .delete(inventoryReservations)
      .where(
        and(
          eq(inventoryReservations.status, 'reserved'),
          lt(inventoryReservations.expiresAt, sql`now()`),
        ),
      )
      .returning({ id: inventoryReservations.id });
    return deleted.length;
  }

  // ── private ─────────────────────────────────────────────────────────────────

  private async deleteReservation(
    executor: DatabaseService['db'] | Tx,
    tenantId: string,
    cartId: string,
    variantId: string,
  ): Promise<void> {
    await executor
      .delete(inventoryReservations)
      .where(
        and(
          eq(inventoryReservations.tenantId, tenantId),
          eq(inventoryReservations.cartId, cartId),
          eq(inventoryReservations.variantId, variantId),
        ),
      );
  }
}
