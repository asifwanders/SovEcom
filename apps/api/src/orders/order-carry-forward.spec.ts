/**
 * unit tests for the folded-in carry-forwards' pure/guarded logic:
 *   - extractValidViesRef (the order-time VIES snapshot guard);
 *   - OrderRestockListener only restocks an UNPAID cancellation.
 */
import { extractValidViesRef } from './orders.service';
import { OrderRestockListener } from './order-restock.listener';
import { OrderStatusChangedEvent } from './events/order-status-changed.event';
import type { DatabaseService } from '../database/database.service';
import type { OrderRepository } from './order.repository';
import type { InventoryService } from '../inventory/inventory.service';
import type { EventEmitter2 } from '@nestjs/event-emitter';

describe('extractValidViesRef', () => {
  it('returns the ref only for a currently-valid VAT proof', () => {
    expect(extractValidViesRef({ vat: { status: 'valid', consultationRef: 'REF-123' } })).toBe(
      'REF-123',
    );
  });
  it('returns null for a non-valid / cached proof or missing ref', () => {
    expect(extractValidViesRef({ vat: { status: 'invalid', consultationRef: 'X' } })).toBeNull();
    expect(extractValidViesRef({ vat: { status: 'valid' } })).toBeNull();
    expect(extractValidViesRef({ vat: { cached: true } })).toBeNull();
    expect(extractValidViesRef({})).toBeNull();
    expect(extractValidViesRef(null)).toBeNull();
    expect(extractValidViesRef('nope')).toBeNull();
  });
});

describe('OrderRestockListener gating', () => {
  function build() {
    const db = { db: { transaction: jest.fn() } };
    const orders = { itemsForOrder: jest.fn() };
    const inventory = { restockInTx: jest.fn() };
    const emit = jest.fn();
    const events = { emit };
    const listener = new OrderRestockListener(
      db as unknown as DatabaseService,
      orders as unknown as OrderRepository,
      inventory as unknown as InventoryService,
      events as unknown as EventEmitter2,
    );
    return { listener, db, orders, emit };
  }

  it('does NOT restock when the order was cancelled from a PAID state (refund flow owns that)', async () => {
    const { listener, orders } = build();
    await listener.onOrderCancelled(
      new OrderStatusChangedEvent('t1', 'o1', 'paid', 'cancelled', 'admin'),
    );
    expect(orders.itemsForOrder).not.toHaveBeenCalled();
  });

  it('restocks when cancelled from pending_payment', async () => {
    const { listener, db, orders } = build();
    orders.itemsForOrder.mockResolvedValue([]); // empty → short-circuits before tx
    await listener.onOrderCancelled(
      new OrderStatusChangedEvent('t1', 'o1', 'pending_payment', 'cancelled', null),
    );
    expect(orders.itemsForOrder).toHaveBeenCalledWith('t1', 'o1');
    expect(db.db.transaction).not.toHaveBeenCalled(); // no items → no tx
  });

  it('never re-throws (a restock failure must not undo the committed cancel)', async () => {
    const { listener, orders } = build();
    orders.itemsForOrder.mockRejectedValue(new Error('db down'));
    await expect(
      listener.onOrderCancelled(
        new OrderStatusChangedEvent('t1', 'o1', 'pending_payment', 'cancelled', null),
      ),
    ).resolves.toBeUndefined();
  });

  it('B2: emits product.stock_changed{available:true} for a restock availability flip', async () => {
    const { listener, db, orders, emit } = build();
    orders.itemsForOrder.mockResolvedValue([{ id: 'oi1', variantId: 'v1', quantity: 2 }]);
    // The tx callback returns the flips the (mocked) restock produced; the listener emits them.
    (db.db.transaction as jest.Mock).mockResolvedValue([
      { variantId: 'v1', productId: 'p1', available: true },
    ]);
    await listener.onOrderCancelled(
      new OrderStatusChangedEvent('t1', 'o1', 'pending_payment', 'cancelled', null),
    );
    const calls = emit.mock.calls.filter((c) => c[0] === 'product.stock_changed');
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toMatchObject({
      tenantId: 't1',
      productId: 'p1',
      variantId: 'v1',
      available: true,
    });
  });
});
