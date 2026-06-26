/**
 * PaymentsService unit tests.
 *
 * Collaborators are mocked. The load-bearing invariants under test:
 *   - the PaymentIntent amount/currency come from the ORDER (server), never the caller;
 *   - the idempotency key is the order id (no double charge on retry);
 *   - velocity caps fail closed and create NO order / NO intent;
 *   - an already-paid order creates no intent;
 *   - a cancelled order is not payable;
 *   - Stripe Customer reuse: created once for a logged-in customer, reused thereafter, never
 *     for a guest.
 */
import { ConflictException, HttpException, UnprocessableEntityException } from '@nestjs/common';
import { PaymentsService, mapIntentStatus } from './payments.service';
import type { OrderService } from '../orders/orders.service';
import type { OrderRepository } from '../orders/order.repository';
import type { PaymentRepository } from './payment.repository';
import type { StripeService } from './stripe/stripe.service';
import type { RateLimitService } from '../auth/services/rate-limit.service';
import type { PaymentProvider } from './providers/payment-provider.interface';
import type { Order } from '../database/schema/orders';

function makeOrder(over: Partial<Order> = {}): Order {
  return {
    id: 'order-1',
    tenantId: 'tenant-1',
    status: 'pending_payment',
    currency: 'EUR',
    totalAmount: 4200,
    customerId: null,
    ...over,
  } as Order;
}

interface Mocks {
  provider: jest.Mocked<PaymentProvider>;
  orders: { createOrLoadFromCart: jest.Mock; transition: jest.Mock };
  orderRepo: { findById: jest.Mock; hasInFlightPayment: jest.Mock };
  payments: {
    upsertByProviderPaymentId: jest.Mock;
    insert: jest.Mock;
    getCustomerForStripe: jest.Mock;
    setStripeCustomerId: jest.Mock;
  };
  stripe: { ensureCustomer: jest.Mock };
  rateLimit: { check: jest.Mock };
}

function build(over: { allowed?: boolean } = {}) {
  const allowed = over.allowed ?? true;
  const mocks: Mocks = {
    provider: {
      name: 'stripe',
      createPaymentIntent: jest.fn().mockResolvedValue({
        id: 'pi_1',
        clientSecret: 'pi_1_secret',
        status: 'requires_payment_method',
      }),
      createRefund: jest.fn(),
    },
    orders: {
      createOrLoadFromCart: jest.fn().mockResolvedValue(makeOrder()),
      transition: jest.fn().mockResolvedValue(makeOrder({ status: 'paid' })),
    },
    orderRepo: {
      findById: jest.fn().mockResolvedValue(makeOrder()),
      hasInFlightPayment: jest.fn().mockResolvedValue(false),
    },
    payments: {
      upsertByProviderPaymentId: jest.fn().mockResolvedValue({}),
      insert: jest.fn().mockResolvedValue({}),
      getCustomerForStripe: jest.fn(),
      setStripeCustomerId: jest.fn().mockResolvedValue(undefined),
    },
    stripe: { ensureCustomer: jest.fn() },
    rateLimit: { check: jest.fn().mockResolvedValue({ allowed, count: 1, degraded: false }) },
  };
  const svc = new PaymentsService(
    mocks.provider,
    mocks.orders as unknown as OrderService,
    mocks.orderRepo as unknown as OrderRepository,
    mocks.payments as unknown as PaymentRepository,
    mocks.stripe as unknown as StripeService,
    mocks.rateLimit as unknown as RateLimitService,
  );
  return { svc, mocks };
}

describe('mapIntentStatus', () => {
  it('maps Stripe statuses onto the payment_status enum', () => {
    expect(mapIntentStatus('succeeded')).toBe('succeeded');
    expect(mapIntentStatus('canceled')).toBe('cancelled');
    expect(mapIntentStatus('requires_payment_method')).toBe('pending');
    expect(mapIntentStatus('processing')).toBe('processing');
  });
});

describe('PaymentsService.createPaymentIntentForCart', () => {
  it('creates an intent for the ORDER total + currency, idempotency-keyed on the order id', async () => {
    const { svc, mocks } = build();
    const res = await svc.createPaymentIntentForCart('tenant-1', 'cart-1', {}, '1.2.3.4');

    expect(mocks.provider.createPaymentIntent).toHaveBeenCalledWith({
      amount: 4200,
      currency: 'EUR',
      customerId: null,
      metadata: { orderId: 'order-1', tenantId: 'tenant-1' },
      idempotencyKey: 'order-1',
    });
    expect(mocks.payments.upsertByProviderPaymentId).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        orderId: 'order-1',
        provider: 'stripe',
        providerPaymentId: 'pi_1',
        amount: 4200,
        currency: 'EUR',
        status: 'pending',
      }),
    );
    expect(res).toEqual({
      orderId: 'order-1',
      status: 'requires_payment',
      clientSecret: 'pi_1_secret',
      amount: 4200,
      currency: 'EUR',
    });
  });

  it('returns processing (no NEW intent) when an in-flight SEPA is already clearing (Fable B1)', async () => {
    const { svc, mocks } = build();
    mocks.orderRepo.hasInFlightPayment.mockResolvedValue(true); // a processing payment exists
    const res = await svc.createPaymentIntentForCart('tenant-1', 'cart-1', {}, 'ip');
    expect(res.status).toBe('processing');
    expect(res.clientSecret).toBeNull();
    expect(mocks.provider.createPaymentIntent).not.toHaveBeenCalled(); // no second charge
  });

  it('returns paid (no intent) when the order is already paid', async () => {
    const { svc, mocks } = build();
    mocks.orders.createOrLoadFromCart.mockResolvedValue(makeOrder({ status: 'paid' }));
    const res = await svc.createPaymentIntentForCart('tenant-1', 'cart-1', {}, 'ip');
    expect(res.status).toBe('paid');
    expect(res.clientSecret).toBeNull();
    expect(mocks.provider.createPaymentIntent).not.toHaveBeenCalled();
  });

  it('rejects a cancelled order (not payable)', async () => {
    const { svc, mocks } = build();
    mocks.orders.createOrLoadFromCart.mockResolvedValue(makeOrder({ status: 'cancelled' }));
    await expect(
      svc.createPaymentIntentForCart('tenant-1', 'cart-1', {}, 'ip'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(mocks.provider.createPaymentIntent).not.toHaveBeenCalled();
  });

  it('fails closed on velocity cap — no order, no intent', async () => {
    const { svc, mocks } = build({ allowed: false });
    await expect(
      svc.createPaymentIntentForCart('tenant-1', 'cart-1', {}, 'ip'),
    ).rejects.toBeInstanceOf(HttpException);
    expect(mocks.orders.createOrLoadFromCart).not.toHaveBeenCalled();
    expect(mocks.provider.createPaymentIntent).not.toHaveBeenCalled();
  });

  it('creates + persists a Stripe Customer for a logged-in customer with none yet', async () => {
    const { svc, mocks } = build();
    mocks.orders.createOrLoadFromCart.mockResolvedValue(makeOrder({ customerId: 'cust-9' }));
    mocks.payments.getCustomerForStripe
      .mockResolvedValueOnce({ email: 'a@b.com', name: 'A', stripeCustomerId: null })
      .mockResolvedValueOnce({ email: 'a@b.com', name: 'A', stripeCustomerId: 'cus_new' });
    mocks.stripe.ensureCustomer.mockResolvedValue('cus_new');

    await svc.createPaymentIntentForCart('tenant-1', 'cart-1', {}, 'ip');

    expect(mocks.stripe.ensureCustomer).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'a@b.com', idempotencyKey: 'cust:tenant-1:cust-9' }),
    );
    expect(mocks.payments.setStripeCustomerId).toHaveBeenCalledWith(
      'tenant-1',
      'cust-9',
      'cus_new',
    );
    expect(mocks.provider.createPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: 'cus_new' }),
    );
  });

  it('reuses an existing Stripe Customer (no create)', async () => {
    const { svc, mocks } = build();
    mocks.orders.createOrLoadFromCart.mockResolvedValue(makeOrder({ customerId: 'cust-9' }));
    mocks.payments.getCustomerForStripe.mockResolvedValue({
      email: 'a@b.com',
      name: 'A',
      stripeCustomerId: 'cus_existing',
    });

    await svc.createPaymentIntentForCart('tenant-1', 'cart-1', {}, 'ip');

    expect(mocks.stripe.ensureCustomer).not.toHaveBeenCalled();
    expect(mocks.provider.createPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: 'cus_existing' }),
    );
  });

  it('never creates a Stripe Customer for a guest order', async () => {
    const { svc, mocks } = build();
    // default order has customerId null
    await svc.createPaymentIntentForCart('tenant-1', 'cart-1', {}, 'ip');
    expect(mocks.payments.getCustomerForStripe).not.toHaveBeenCalled();
    expect(mocks.stripe.ensureCustomer).not.toHaveBeenCalled();
    expect(mocks.provider.createPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: null }),
    );
  });
});

describe('PaymentsService.recordManualPayment', () => {
  it('drives → paid (expectedFrom pending_payment) THEN writes a manual succeeded payment row', async () => {
    const { svc, mocks } = build();
    const res = await svc.recordManualPayment('tenant-1', 'order-1', {
      method: 'bank_transfer',
      actorUserId: 'admin-1',
    });

    // transition is driven first, guarded so a concurrent pay can't double-apply.
    expect(mocks.orders.transition).toHaveBeenCalledWith(
      'tenant-1',
      'order-1',
      'paid',
      expect.objectContaining({ expectedFrom: 'pending_payment', changedBy: 'admin-1' }),
    );
    expect(mocks.payments.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'manual',
        providerPaymentId: null,
        method: 'bank_transfer',
        amount: 4200, // defaults to the order total
        status: 'succeeded',
      }),
    );
    expect(res).toMatchObject({ orderId: 'order-1', status: 'paid', amount: 4200 });
  });

  it('accepts an explicit amount that equals the order total', async () => {
    const { svc, mocks } = build();
    mocks.orderRepo.findById.mockResolvedValue(makeOrder({ totalAmount: 4200 }));
    await svc.recordManualPayment('tenant-1', 'order-1', {
      method: 'cash',
      amount: 4200, // matches the order total
      actorUserId: 'admin-1',
    });
    expect(mocks.payments.insert).toHaveBeenCalledWith(expect.objectContaining({ amount: 4200 }));
  });

  it('rejects an amount ≠ the order total BEFORE paying (Fable B4 — no orphan)', async () => {
    const { svc, mocks } = build();
    mocks.orderRepo.findById.mockResolvedValue(makeOrder({ totalAmount: 4200 }));
    await expect(
      svc.recordManualPayment('tenant-1', 'order-1', {
        method: 'cash',
        amount: 999,
        actorUserId: 'a',
      }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(mocks.orders.transition).not.toHaveBeenCalled(); // never paid
    expect(mocks.payments.insert).not.toHaveBeenCalled();
  });

  it('propagates a 409 from the transition and writes NO payment row', async () => {
    const { svc, mocks } = build();
    mocks.orders.transition.mockRejectedValue(new ConflictException('not pending_payment'));
    await expect(
      svc.recordManualPayment('tenant-1', 'order-1', { method: 'cod', actorUserId: 'a' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(mocks.payments.insert).not.toHaveBeenCalled();
  });
});
