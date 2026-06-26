/**
 * PaymentWebhookService unit tests.
 *
 * The webhook is the source of truth for "paid". Invariants under test:
 *   - a bad signature is rejected (verify throws, nothing processed);
 *   - a duplicate event is a no-op (idempotency / replay protection);
 *   - succeeded → marks payment succeeded + drives order → paid (once);
 *   - an already-paid order is NOT transitioned again (no double-issue);
 *   - a cancelled order is NOT transitioned (paid-after-cancel is logged, not applied);
 *   - failed → payment failed, no transition;
 *   - dispute.created → records + freezes; dispute.updated → records, no freeze;
 *   - a handler failure releases the event claim so Stripe retries.
 */
import { BadRequestException } from '@nestjs/common';
import {
  PaymentWebhookService,
  mapDisputeStatus,
  safeEventPayload,
} from './payment-webhook.service';
import type { StripeEvent } from './stripe/stripe.types';
import type { StripeService } from './stripe/stripe.service';
import type { PaymentEventRepository } from './payment-event.repository';
import type { PaymentRepository } from './payment.repository';
import type { DisputeRepository } from './dispute.repository';
import type { OrderService } from '../orders/orders.service';
import type { OrderRepository } from '../orders/order.repository';
import type { RefundService } from './refunds/refund.service';
import type { DatabaseService } from '../database/database.service';

interface Mocks {
  stripe: { constructWebhookEvent: jest.Mock };
  events: { claimEvent: jest.Mock; markProcessed: jest.Mock };
  payments: {
    upsertByProviderPaymentId: jest.Mock;
    findByProviderPaymentId: jest.Mock;
    updateStatus: jest.Mock;
    hasSucceededPaymentExcept: jest.Mock;
  };
  disputes: { upsertByProviderDisputeId: jest.Mock; findByProviderDisputeId: jest.Mock };
  orders: { transition: jest.Mock };
  orderRepo: {
    findById: jest.Mock;
    findByIdForUpdate: jest.Mock;
    setFulfillmentFrozen: jest.Mock;
  };
  refundService: { reconcileGatewayRefund: jest.Mock };
  db: { db: { transaction: jest.Mock } };
}

function build() {
  const mocks: Mocks = {
    stripe: { constructWebhookEvent: jest.fn() },
    events: {
      claimEvent: jest.fn().mockResolvedValue('new'),
      markProcessed: jest.fn().mockResolvedValue(undefined),
    },
    payments: {
      upsertByProviderPaymentId: jest.fn().mockResolvedValue({}),
      findByProviderPaymentId: jest.fn(),
      updateStatus: jest.fn().mockResolvedValue(undefined),
      hasSucceededPaymentExcept: jest.fn().mockResolvedValue(false),
    },
    disputes: {
      upsertByProviderDisputeId: jest.fn().mockResolvedValue({}),
      findByProviderDisputeId: jest.fn().mockResolvedValue(null),
    },
    orders: { transition: jest.fn().mockResolvedValue({}) },
    orderRepo: {
      findById: jest.fn(),
      // FOR UPDATE lock — the dispute handler serialises through this. Default: order exists.
      findByIdForUpdate: jest
        .fn()
        .mockResolvedValue({ id: 'order-1', tenantId: 'tenant-1', status: 'paid' }),
      setFulfillmentFrozen: jest.fn().mockResolvedValue(undefined),
    },
    refundService: { reconcileGatewayRefund: jest.fn().mockResolvedValue(undefined) },
    // A pass-through transaction stand-in: invoke the callback with a sentinel `tx` so the
    // handler's read+freeze run "inside" it. The real DB serialises concurrent disputes via the
    // FOR UPDATE row lock; here we assert the handler takes the lock and is a no-op on redelivery.
    db: { db: { transaction: jest.fn(async (cb: (tx: unknown) => unknown) => cb('tx')) } },
  };
  const svc = new PaymentWebhookService(
    mocks.stripe as unknown as StripeService,
    mocks.events as unknown as PaymentEventRepository,
    mocks.payments as unknown as PaymentRepository,
    mocks.disputes as unknown as DisputeRepository,
    mocks.orders as unknown as OrderService,
    mocks.orderRepo as unknown as OrderRepository,
    mocks.refundService as unknown as RefundService,
    mocks.db as unknown as DatabaseService,
  );
  return { svc, mocks };
}

function piEvent(over: Record<string, unknown> = {}, type = 'payment_intent.succeeded') {
  return {
    id: 'evt_1',
    type,
    data: {
      object: {
        id: 'pi_1',
        status: 'succeeded',
        amount: 4200,
        currency: 'eur',
        metadata: { orderId: 'order-1', tenantId: 'tenant-1' },
        ...over,
      },
    },
  };
}

describe('mapDisputeStatus', () => {
  it('maps to the coarse enum', () => {
    expect(mapDisputeStatus('won')).toBe('won');
    expect(mapDisputeStatus('lost')).toBe('lost');
    expect(mapDisputeStatus('needs_response')).toBe('open');
    expect(mapDisputeStatus('warning_under_review')).toBe('open');
  });
});

describe('safeEventPayload (Fable B2 — no secret/PII at rest)', () => {
  it('keeps only id/type/objectId/objectStatus — strips client_secret + PII', () => {
    const event = {
      id: 'evt_1',
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: 'pi_1',
          status: 'succeeded',
          client_secret: 'pi_1_secret_LEAK',
          receipt_email: 'buyer@example.com',
          customer: 'cus_1',
        },
      },
    } as unknown as StripeEvent;
    const out = safeEventPayload(event);
    expect(out).toEqual({
      id: 'evt_1',
      type: 'payment_intent.succeeded',
      objectId: 'pi_1',
      objectStatus: 'succeeded',
    });
    expect(JSON.stringify(out)).not.toContain('secret');
    expect(JSON.stringify(out)).not.toContain('buyer@example.com');
  });
});

describe('PaymentWebhookService.processWebhook — verification + dedup', () => {
  it('rejects a bad signature (nothing processed)', async () => {
    const { svc, mocks } = build();
    mocks.stripe.constructWebhookEvent.mockImplementation(() => {
      throw new BadRequestException('Invalid webhook signature');
    });
    await expect(svc.processWebhook(Buffer.from('{}'), 'bad')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(mocks.events.claimEvent).not.toHaveBeenCalled();
    expect(mocks.orders.transition).not.toHaveBeenCalled();
  });

  it('no-ops a fully-processed duplicate event (replay protection)', async () => {
    const { svc, mocks } = build();
    mocks.stripe.constructWebhookEvent.mockReturnValue(piEvent());
    mocks.events.claimEvent.mockResolvedValue('done'); // already processed
    await svc.processWebhook(Buffer.from('{}'), 'sig');
    expect(mocks.orderRepo.findById).not.toHaveBeenCalled();
    expect(mocks.orders.transition).not.toHaveBeenCalled();
    expect(mocks.events.markProcessed).not.toHaveBeenCalled();
  });

  it('REPROCESSES an unprocessed claim (Fable B1: a crash before dispatch is recovered)', async () => {
    const { svc, mocks } = build();
    mocks.stripe.constructWebhookEvent.mockReturnValue(piEvent());
    mocks.events.claimEvent.mockResolvedValue('unprocessed'); // prior attempt died before dispatch
    mocks.orderRepo.findById.mockResolvedValue({
      id: 'order-1',
      tenantId: 'tenant-1',
      status: 'pending_payment',
      totalAmount: 4200,
      currency: 'EUR',
    });
    await svc.processWebhook(Buffer.from('{}'), 'sig');
    expect(mocks.orders.transition).toHaveBeenCalledWith(
      'tenant-1',
      'order-1',
      'paid',
      expect.any(Object),
    );
    expect(mocks.events.markProcessed).toHaveBeenCalledWith('stripe', 'evt_1');
  });

  it('does NOT mark processed and rethrows when a handler fails (claim left for retry)', async () => {
    const { svc, mocks } = build();
    mocks.stripe.constructWebhookEvent.mockReturnValue(piEvent());
    mocks.orderRepo.findById.mockResolvedValue({
      id: 'order-1',
      tenantId: 'tenant-1',
      status: 'pending_payment',
      totalAmount: 4200,
      currency: 'EUR',
    });
    mocks.orders.transition.mockRejectedValue(new Error('db down'));
    await expect(svc.processWebhook(Buffer.from('{}'), 'sig')).rejects.toThrow('db down');
    // Claim is left with processed_at=NULL (not deleted) → Stripe retry → 'unprocessed' → reprocess.
    expect(mocks.events.markProcessed).not.toHaveBeenCalled();
  });
});

describe('PaymentWebhookService — payment_intent.succeeded', () => {
  it('marks payment succeeded and drives a pending order → paid (once)', async () => {
    const { svc, mocks } = build();
    mocks.stripe.constructWebhookEvent.mockReturnValue(piEvent());
    mocks.orderRepo.findById.mockResolvedValue({
      id: 'order-1',
      tenantId: 'tenant-1',
      status: 'pending_payment',
      totalAmount: 4200,
      currency: 'EUR',
    });
    await svc.processWebhook(Buffer.from('{}'), 'sig');

    expect(mocks.payments.upsertByProviderPaymentId).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        orderId: 'order-1',
        providerPaymentId: 'pi_1',
        amount: 4200,
        currency: 'EUR',
        status: 'succeeded',
      }),
    );
    expect(mocks.orders.transition).toHaveBeenCalledWith(
      'tenant-1',
      'order-1',
      'paid',
      expect.any(Object),
    );
    expect(mocks.events.markProcessed).toHaveBeenCalledWith('stripe', 'evt_1');
  });

  it('does NOT transition an already-paid order (idempotent replay)', async () => {
    const { svc, mocks } = build();
    mocks.stripe.constructWebhookEvent.mockReturnValue(piEvent());
    mocks.orderRepo.findById.mockResolvedValue({
      id: 'order-1',
      tenantId: 'tenant-1',
      status: 'paid',
      totalAmount: 4200,
      currency: 'EUR',
    });
    await svc.processWebhook(Buffer.from('{}'), 'sig');
    expect(mocks.orders.transition).not.toHaveBeenCalled();
    expect(mocks.payments.upsertByProviderPaymentId).toHaveBeenCalled(); // still records succeeded
  });

  it('does NOT transition a cancelled order (paid-after-cancel is logged, not applied)', async () => {
    const { svc, mocks } = build();
    mocks.stripe.constructWebhookEvent.mockReturnValue(piEvent());
    mocks.orderRepo.findById.mockResolvedValue({
      id: 'order-1',
      tenantId: 'tenant-1',
      status: 'cancelled',
      totalAmount: 4200,
      currency: 'EUR',
    });
    await svc.processWebhook(Buffer.from('{}'), 'sig');
    expect(mocks.orders.transition).not.toHaveBeenCalled();
  });

  it('ignores an intent with no resolvable order (no metadata)', async () => {
    const { svc, mocks } = build();
    mocks.stripe.constructWebhookEvent.mockReturnValue(piEvent({ metadata: {} }));
    await svc.processWebhook(Buffer.from('{}'), 'sig');
    expect(mocks.orderRepo.findById).not.toHaveBeenCalled();
    expect(mocks.orders.transition).not.toHaveBeenCalled();
  });
});

describe('PaymentWebhookService — payment_intent.processing (SEPA async)', () => {
  it('records the payment as processing and does NOT transition the order', async () => {
    const { svc, mocks } = build();
    mocks.stripe.constructWebhookEvent.mockReturnValue(
      piEvent({ status: 'processing' }, 'payment_intent.processing'),
    );
    mocks.orderRepo.findById.mockResolvedValue({
      id: 'order-1',
      tenantId: 'tenant-1',
      status: 'pending_payment',
      totalAmount: 4200,
      currency: 'EUR',
    });
    await svc.processWebhook(Buffer.from('{}'), 'sig');
    expect(mocks.payments.upsertByProviderPaymentId).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: 'order-1', status: 'processing' }),
    );
    expect(mocks.orders.transition).not.toHaveBeenCalled();
  });
});

describe('PaymentWebhookService — payment_intent.payment_failed', () => {
  it('marks the payment failed and does not transition the order', async () => {
    const { svc, mocks } = build();
    mocks.stripe.constructWebhookEvent.mockReturnValue(
      piEvent({ status: 'requires_payment_method' }, 'payment_intent.payment_failed'),
    );
    mocks.payments.findByProviderPaymentId.mockResolvedValue({
      id: 'pay-1',
      tenantId: 'tenant-1',
      orderId: 'order-1',
    });
    await svc.processWebhook(Buffer.from('{}'), 'sig');
    expect(mocks.payments.updateStatus).toHaveBeenCalledWith('tenant-1', 'pay-1', 'failed');
    expect(mocks.orders.transition).not.toHaveBeenCalled();
  });
});

describe('PaymentWebhookService — charge.refunded (dashboard reconciliation)', () => {
  function refundEvent(refunds: { id: string; amount: number; status: string }[]) {
    return {
      id: 'evt_cr',
      type: 'charge.refunded',
      data: { object: { id: 'ch_1', payment_intent: 'pi_1', refunds: { data: refunds } } },
    };
  }

  it('reconciles each succeeded refund on the charge via RefundService', async () => {
    const { svc, mocks } = build();
    mocks.stripe.constructWebhookEvent.mockReturnValue(
      refundEvent([{ id: 're_1', amount: 500, status: 'succeeded' }]),
    );
    mocks.payments.findByProviderPaymentId.mockResolvedValue({
      id: 'pay-1',
      tenantId: 'tenant-1',
      orderId: 'order-1',
    });
    await svc.processWebhook(Buffer.from('{}'), 'sig');
    expect(mocks.refundService.reconcileGatewayRefund).toHaveBeenCalledWith(
      'tenant-1',
      'order-1',
      're_1',
      500,
      'succeeded',
    );
  });

  it('reconciles a refund.created event (the primary modern-API path)', async () => {
    const { svc, mocks } = build();
    mocks.stripe.constructWebhookEvent.mockReturnValue({
      id: 'evt_rc',
      type: 'refund.created',
      data: { object: { id: 're_2', payment_intent: 'pi_1', amount: 700, status: 'succeeded' } },
    });
    mocks.payments.findByProviderPaymentId.mockResolvedValue({
      id: 'pay-1',
      tenantId: 'tenant-1',
      orderId: 'order-1',
    });
    await svc.processWebhook(Buffer.from('{}'), 'sig');
    expect(mocks.refundService.reconcileGatewayRefund).toHaveBeenCalledWith(
      'tenant-1',
      'order-1',
      're_2',
      700,
      'succeeded',
    );
  });

  it('skips non-succeeded refunds and ignores an unlinkable charge', async () => {
    const { svc, mocks } = build();
    mocks.stripe.constructWebhookEvent.mockReturnValue(
      refundEvent([{ id: 're_p', amount: 1, status: 'pending' }]),
    );
    mocks.payments.findByProviderPaymentId.mockResolvedValue({
      id: 'pay-1',
      tenantId: 'tenant-1',
      orderId: 'order-1',
    });
    await svc.processWebhook(Buffer.from('{}'), 'sig');
    expect(mocks.refundService.reconcileGatewayRefund).not.toHaveBeenCalled();
  });
});

describe('PaymentWebhookService — disputes', () => {
  function disputeEvent(type: string, over: Record<string, unknown> = {}) {
    return {
      id: 'evt_d',
      type,
      data: {
        object: {
          id: 'dp_1',
          amount: 4200,
          currency: 'eur',
          reason: 'fraudulent',
          status: 'needs_response',
          payment_intent: 'pi_1',
          evidence_details: { due_by: 1_700_000_000 },
          ...over,
        },
      },
    };
  }

  it('charge.dispute.created records the dispute AND freezes fulfillment', async () => {
    const { svc, mocks } = build();
    mocks.stripe.constructWebhookEvent.mockReturnValue(disputeEvent('charge.dispute.created'));
    mocks.payments.findByProviderPaymentId.mockResolvedValue({
      id: 'pay-1',
      tenantId: 'tenant-1',
      orderId: 'order-1',
    });
    await svc.processWebhook(Buffer.from('{}'), 'sig');

    expect(mocks.disputes.upsertByProviderDisputeId).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        orderId: 'order-1',
        paymentId: 'pay-1',
        providerDisputeId: 'dp_1',
        currency: 'EUR',
        status: 'open',
      }),
      'tx',
    );
    expect(mocks.orderRepo.setFulfillmentFrozen).toHaveBeenCalledWith(
      'tenant-1',
      'order-1',
      true,
      'tx',
    );
  });

  it('charge.dispute.updated records the dispute but does NOT (re)freeze', async () => {
    const { svc, mocks } = build();
    mocks.stripe.constructWebhookEvent.mockReturnValue(
      disputeEvent('charge.dispute.updated', { status: 'won' }),
    );
    mocks.payments.findByProviderPaymentId.mockResolvedValue({
      id: 'pay-1',
      tenantId: 'tenant-1',
      orderId: 'order-1',
    });
    await svc.processWebhook(Buffer.from('{}'), 'sig');
    expect(mocks.disputes.upsertByProviderDisputeId).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'won' }),
      'tx',
    );
    expect(mocks.orderRepo.setFulfillmentFrozen).not.toHaveBeenCalled();
  });

  it('ignores a dispute that cannot be linked to a payment', async () => {
    const { svc, mocks } = build();
    mocks.stripe.constructWebhookEvent.mockReturnValue(disputeEvent('charge.dispute.created'));
    mocks.payments.findByProviderPaymentId.mockResolvedValue(null);
    await svc.processWebhook(Buffer.from('{}'), 'sig');
    expect(mocks.disputes.upsertByProviderDisputeId).not.toHaveBeenCalled();
    expect(mocks.orderRepo.setFulfillmentFrozen).not.toHaveBeenCalled();
  });

  // out-of-order charge.dispute.* must not regress a resolved dispute or re-freeze.
  it('redelivered charge.dispute.created after a WON close does NOT regress status nor re-freeze', async () => {
    const { svc, mocks } = build();
    mocks.payments.findByProviderPaymentId.mockResolvedValue({
      id: 'pay-1',
      tenantId: 'tenant-1',
      orderId: 'order-1',
    });
    // The dispute already resolved WON (admin won + unfroze the order).
    mocks.disputes.findByProviderDisputeId.mockResolvedValue({
      id: 'd-row',
      status: 'won',
      orderId: 'order-1',
    });
    // Stripe redelivers an OLD `created` (needs_response) event with a fresh event id.
    mocks.stripe.constructWebhookEvent.mockReturnValue(
      disputeEvent('charge.dispute.created', { status: 'needs_response' }),
    );
    await svc.processWebhook(Buffer.from('{}'), 'sig');

    // Status NOT overwritten back to open, and the order NOT re-frozen.
    expect(mocks.disputes.upsertByProviderDisputeId).not.toHaveBeenCalled();
    expect(mocks.orderRepo.setFulfillmentFrozen).not.toHaveBeenCalled();
  });

  it('redelivered charge.dispute.created for an already-open dispute does NOT re-freeze', async () => {
    const { svc, mocks } = build();
    mocks.payments.findByProviderPaymentId.mockResolvedValue({
      id: 'pay-1',
      tenantId: 'tenant-1',
      orderId: 'order-1',
    });
    // The dispute already exists (still open); admin may have unfrozen while working it.
    mocks.disputes.findByProviderDisputeId.mockResolvedValue({
      id: 'd-row',
      status: 'open',
      orderId: 'order-1',
    });
    mocks.stripe.constructWebhookEvent.mockReturnValue(disputeEvent('charge.dispute.created'));
    await svc.processWebhook(Buffer.from('{}'), 'sig');

    // Status is refreshed (still open) but the freeze is NOT re-applied.
    expect(mocks.disputes.upsertByProviderDisputeId).toHaveBeenCalled();
    expect(mocks.orderRepo.setFulfillmentFrozen).not.toHaveBeenCalled();
  });

  // P1 — the read→decide→freeze sequence must run inside ONE order-row-locked transaction so
  // concurrent / redelivered dispute deliveries serialise (no double-freeze, no re-freeze after
  // an admin unfreeze). These tests pin the locking contract that closes the TOCTOU.
  describe('P1 — dispute freeze serialisation (order-row lock)', () => {
    it('takes the order FOR UPDATE lock and reads+freezes INSIDE the transaction', async () => {
      const { svc, mocks } = build();
      mocks.stripe.constructWebhookEvent.mockReturnValue(disputeEvent('charge.dispute.created'));
      mocks.payments.findByProviderPaymentId.mockResolvedValue({
        id: 'pay-1',
        tenantId: 'tenant-1',
        orderId: 'order-1',
      });
      mocks.disputes.findByProviderDisputeId.mockResolvedValue(null); // first delivery
      await svc.processWebhook(Buffer.from('{}'), 'sig');

      // The whole sequence ran in a transaction…
      expect(mocks.db.db.transaction).toHaveBeenCalledTimes(1);
      // …that began by locking the order row FOR UPDATE (serialisation point)…
      expect(mocks.orderRepo.findByIdForUpdate).toHaveBeenCalledWith('tx', 'tenant-1', 'order-1');
      // …and the existence read + freeze ran under that same tx handle.
      expect(mocks.disputes.findByProviderDisputeId).toHaveBeenCalledWith('tenant-1', 'dp_1', 'tx');
      expect(mocks.orderRepo.setFulfillmentFrozen).toHaveBeenCalledWith(
        'tenant-1',
        'order-1',
        true,
        'tx',
      );
    });

    it('a SECOND delivery that now sees an existing dispute row is a no-op freeze (TOCTOU closed)', async () => {
      const { svc, mocks } = build();
      mocks.payments.findByProviderPaymentId.mockResolvedValue({
        id: 'pay-1',
        tenantId: 'tenant-1',
        orderId: 'order-1',
      });
      // First call commits the dispute row; the lock is released; the SECOND delivery (a
      // redelivered `created` with a FRESH event id) now reads the committed row under the lock.
      mocks.disputes.findByProviderDisputeId.mockResolvedValue({
        id: 'd-row',
        status: 'open',
        orderId: 'order-1',
      });
      mocks.stripe.constructWebhookEvent.mockReturnValue(disputeEvent('charge.dispute.created'));
      await svc.processWebhook(Buffer.from('{}'), 'sig');

      // Existing row seen → NO second freeze. An admin may have unfrozen mid-dispute.
      expect(mocks.orderRepo.setFulfillmentFrozen).not.toHaveBeenCalled();
    });

    it('rolls back (rethrows) when the in-tx freeze fails, leaving the claim for Stripe retry', async () => {
      const { svc, mocks } = build();
      mocks.stripe.constructWebhookEvent.mockReturnValue(disputeEvent('charge.dispute.created'));
      mocks.payments.findByProviderPaymentId.mockResolvedValue({
        id: 'pay-1',
        tenantId: 'tenant-1',
        orderId: 'order-1',
      });
      mocks.disputes.findByProviderDisputeId.mockResolvedValue(null);
      mocks.orderRepo.setFulfillmentFrozen.mockRejectedValue(new Error('lock timeout'));
      await expect(svc.processWebhook(Buffer.from('{}'), 'sig')).rejects.toThrow('lock timeout');
      expect(mocks.events.markProcessed).not.toHaveBeenCalled();
    });
  });
});
