/**
 * OrderRestockListener — restores stock when unpaid orders are cancelled.
 *
 * When an unpaid order is cancelled (`pending_payment → cancelled`, by the stale-unpaid sweeper
 * or an admin), the stock consumed at order creation is restored. This is the release valve
 * that stops abandoned/expired payment attempts from leaking stock forever.
 *
 * Gated on `fromStatus === 'pending_payment'` only: a paid order's cancellation restocks via the
 * refund flow, not here, so we never double-credit. Fires exactly once per order
 * (a cancelled order is terminal), so no double-restock.
 *
 * Mirrors createFromCart's consume in reverse: a non-bundle line restocks its own variant; a
 * bundle parent line re-expands to its components and restocks each × line quantity. Best-effort
 * (post-commit): a failure is logged, never re-thrown — the cancel stands.
 */
import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { DatabaseService } from '../database/database.service';
import { OrderRepository } from './order.repository';
import { InventoryService, type StockFlip } from '../inventory/inventory.service';
import { OrderStatusChangedEvent } from './events/order-status-changed.event';
import { ProductStockChangedEvent } from '../catalog/events/product-stock-changed.event';

@Injectable()
export class OrderRestockListener {
  private readonly logger = new Logger(OrderRestockListener.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly orders: OrderRepository,
    private readonly inventory: InventoryService,
    private readonly events: EventEmitter2,
  ) {}

  @OnEvent('order.cancelled')
  async onOrderCancelled(event: OrderStatusChangedEvent): Promise<void> {
    // Only an unpaid cancellation restocks (stock was consumed at order creation).
    if (event.fromStatus !== 'pending_payment') return;
    try {
      const flips = await this.restockOrder(event.tenantId, event.orderId);
      // POST-COMMIT: a restock that flipped a variant from 0 to positive emits product.stock_changed
      // {available:true} so the back-in-stock notifier observes it. Boolean-only; never the level.
      for (const f of flips) {
        this.events.emit(
          ProductStockChangedEvent.EVENT,
          new ProductStockChangedEvent(event.tenantId, f.productId, f.variantId, f.available),
        );
      }
      this.logger.log(`Restocked cancelled unpaid order ${event.orderId}`);
    } catch (err) {
      // Do NOT re-throw: the cancel already committed; surface for manual reconciliation.
      this.logger.error(`Restock failed for cancelled order ${event.orderId}`, err);
    }
  }

  /**
   * Restore the consumed stock of an order's lines (bundle-aware), tenant-scoped, in one tx.
   * Returns the availability flips (0 → positive) for POST-COMMIT `product.stock_changed` emission.
   */
  private async restockOrder(tenantId: string, orderId: string): Promise<StockFlip[]> {
    const allItems = await this.orders.itemsForOrder(tenantId, orderId);
    // A line whose variant was since deleted has variant_id NULL — there is no stock row to
    // credit, so it is skipped (best-effort restock).
    const items = allItems.filter(
      (i): i is typeof i & { variantId: string } => i.variantId !== null,
    );
    if (items.length === 0) return [];

    return this.db.db.transaction(async (tx) => {
      const flips: StockFlip[] = [];
      const variantIds = items.map((i) => i.variantId);
      const meta = await this.orders.loadVariantsForSnapshot(tx, tenantId, variantIds);

      // Lock variants in ascending id order (mirrors createFromCart) to avoid deadlocks with a
      // concurrent checkout touching overlapping variants.
      const byVariant = [...items].sort((a, b) =>
        a.variantId < b.variantId ? -1 : a.variantId > b.variantId ? 1 : 0,
      );
      for (const item of byVariant) {
        const m = meta.get(item.variantId);
        if (m?.isBundle) {
          // Re-expand: the consumed units were the components × line qty (the parent placeholder
          // was never decremented). Restock each component.
          const components = await this.orders.loadBundleComponents(tx, tenantId, m.productId);
          const componentsByVariant = [...components].sort((a, b) =>
            a.variantId < b.variantId ? -1 : a.variantId > b.variantId ? 1 : 0,
          );
          for (const c of componentsByVariant) {
            const flip = await this.inventory.restockInTx(
              tx,
              tenantId,
              c.variantId,
              c.quantity * item.quantity,
            );
            if (flip) flips.push(flip);
          }
        } else {
          const flip = await this.inventory.restockInTx(
            tx,
            tenantId,
            item.variantId,
            item.quantity,
          );
          if (flip) flips.push(flip);
        }
      }
      return flips;
    });
  }
}
