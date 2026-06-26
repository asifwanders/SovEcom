/**
 * ReturnsService.request must AGGREGATE duplicate orderItemId lines (sum quantities)
 * before the per-line eligibility check. Without it, [{X,N},{X,N}] each passed independently
 * while 2N exceeds the remaining quantity, persisting a junk over-quantity `requested` return.
 */
import { UnprocessableEntityException } from '@nestjs/common';
import { ReturnsService } from './returns.service';
import type { OrderService } from '../orders/orders.service';
import type { OrderRepository } from '../orders/order.repository';
import type { RefundService } from '../payments/refunds/refund.service';
import type { ReturnRepository } from './return.repository';

function makeOrderItem(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'oi-1',
    quantity: 2,
    refundedQuantity: 0,
    ...over,
  } as never;
}

describe('ReturnsService.request — aggregate duplicate orderItemId lines', () => {
  function makeService(orderItem: ReturnType<typeof makeOrderItem>) {
    const insert = jest.fn(async (row: unknown) => row as never);
    const orders = {
      findForCustomer: jest.fn(async () => ({
        order: { id: 'o1', status: 'paid' },
        items: [orderItem],
      })),
    } as unknown as OrderService;
    const orderRepo = {
      getDeliveredAt: jest.fn(async () => null), // window open
    } as unknown as OrderRepository;
    const refunds = {} as unknown as RefundService;
    const repo = { insert } as unknown as ReturnRepository;
    return { svc: new ReturnsService(orders, orderRepo, refunds, repo), insert };
  }

  it('rejects duplicate lines whose SUMMED quantity exceeds the remaining', async () => {
    // remaining = 2; two lines of 1 each sum to 2 (OK on its own) — make them sum past it.
    const { svc, insert } = makeService(makeOrderItem({ quantity: 2, refundedQuantity: 0 }));
    await expect(
      svc.request('t1', 'cust1', 'o1', {
        type: 'return',
        items: [
          { orderItemId: 'oi-1', quantity: 2 },
          { orderItemId: 'oi-1', quantity: 1 },
        ],
      }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(insert).not.toHaveBeenCalled();
  });

  it('still accepts duplicate lines whose SUMMED quantity is within the remaining', async () => {
    const { svc, insert } = makeService(makeOrderItem({ quantity: 4, refundedQuantity: 0 }));
    await svc.request('t1', 'cust1', 'o1', {
      type: 'return',
      items: [
        { orderItemId: 'oi-1', quantity: 2 },
        { orderItemId: 'oi-1', quantity: 1 },
      ],
    });
    expect(insert).toHaveBeenCalledTimes(1);
  });
});
