/**
 * A gateway-initiated (Stripe-dashboard) refund reconciled via the `charge.refunded` webhook
 * must write an `order.refunded.gateway` audit_log row. `create` runs with actorUserId:null and
 * writes none; the dedup payment_events ledger is NOT a substitute (the audit query/export API
 * reads only audit_log). RefundService.reconcileGatewayRefund records a system-actor entry.
 */
import { RefundService } from './refund.service';
import type { AuditService } from '../../audit/audit.service';
import type { RefundRepository } from './refund.repository';

describe('RefundService.reconcileGatewayRefund — audit trail for gateway refunds', () => {
  function makeService(opts: { existing: unknown }) {
    const record = jest.fn(async () => undefined);
    const audit = { record } as unknown as AuditService;
    const refunds = {
      findByProviderRefundId: jest.fn(async () => opts.existing),
    } as unknown as RefundRepository;
    // `create` is the heavy money path — stub it on the instance so the test isolates the audit
    // write on the gateway-reconcile branch.
    const svc = new RefundService(
      {} as never, // db
      {} as never, // orders
      {} as never, // payments
      refunds,
      {} as never, // invoices
      {} as never, // inventory
      {} as never, // tenantSettings
      {} as never, // events
      audit,
      {} as never, // provider
    );
    jest.spyOn(svc, 'create').mockResolvedValue({} as never);
    return { svc, record };
  }

  it('writes an order.refunded.gateway audit row for a NEW gateway refund', async () => {
    const { svc, record } = makeService({ existing: null });
    await svc.reconcileGatewayRefund('t1', 'order-1', 're_abc', 500, 'succeeded');
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 't1',
        actorType: 'system',
        action: 'order.refunded.gateway',
        resourceType: 'order',
        resourceId: 'order-1',
        changes: { providerRefundId: 're_abc', amount: 500, providerStatus: 'succeeded' },
      }),
    );
  });

  it('does NOT re-audit an already-recorded refund (idempotent webhook replay)', async () => {
    const { svc, record } = makeService({ existing: { id: 'r1', status: 'succeeded' } });
    await svc.reconcileGatewayRefund('t1', 'order-1', 're_abc', 500, 'succeeded');
    expect(record).not.toHaveBeenCalled();
  });
});
