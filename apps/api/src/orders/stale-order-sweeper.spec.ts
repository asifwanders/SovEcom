/**
 * StaleOrderSweeperService unit tests.
 */
import { ConflictException } from '@nestjs/common';
import { StaleOrderSweeperService } from './stale-order-sweeper.service';
import type { OrderRepository } from './order.repository';
import type { OrderService } from './orders.service';

function build() {
  const orders = { findStalePendingPayment: jest.fn() };
  const orderService = { transition: jest.fn().mockResolvedValue({}) };
  const svc = new StaleOrderSweeperService(
    orders as unknown as OrderRepository,
    orderService as unknown as OrderService,
  );
  return { svc, orders, orderService };
}

describe('StaleOrderSweeperService.sweep', () => {
  it('cancels each stale order with the pending_payment expectedFrom guard', async () => {
    const { svc, orders, orderService } = build();
    orders.findStalePendingPayment.mockResolvedValue([
      { id: 'o1', tenantId: 't1' },
      { id: 'o2', tenantId: 't1' },
    ]);
    const cancelled = await svc.sweep();
    expect(cancelled).toBe(2);
    expect(orderService.transition).toHaveBeenCalledWith(
      't1',
      'o1',
      'cancelled',
      expect.objectContaining({ expectedFrom: 'pending_payment', changedBy: null }),
    );
  });

  it('skips an order that was paid concurrently (409) without failing the sweep', async () => {
    const { svc, orders, orderService } = build();
    orders.findStalePendingPayment.mockResolvedValue([
      { id: 'paid-now', tenantId: 't1' },
      { id: 'o2', tenantId: 't1' },
    ]);
    orderService.transition
      .mockRejectedValueOnce(new ConflictException('order changed'))
      .mockResolvedValueOnce({});
    const cancelled = await svc.sweep();
    expect(cancelled).toBe(1); // only o2
  });

  it('uses UNPAID_ORDER_TTL_MINUTES when set, with a cutoff in the past', async () => {
    const { svc, orders } = build();
    process.env.UNPAID_ORDER_TTL_MINUTES = '15';
    orders.findStalePendingPayment.mockResolvedValue([]);
    await svc.sweep();
    const [cutoff, limit] = orders.findStalePendingPayment.mock.calls[0];
    expect(cutoff).toBeInstanceOf(Date);
    expect((cutoff as Date).getTime()).toBeLessThan(Date.now());
    expect(limit).toBeGreaterThan(0);
    delete process.env.UNPAID_ORDER_TTL_MINUTES;
  });
});
