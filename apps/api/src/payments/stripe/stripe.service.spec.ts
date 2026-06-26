/**
 * StripeService unit tests.
 *
 * The Stripe SDK is mocked entirely (no live keys). We assert the wrapper passes the right
 * arguments (amount/currency/idempotency), maps results, and fails closed on signature/secret
 * problems.
 */
import { ServiceUnavailableException, BadRequestException } from '@nestjs/common';
import { StripeService } from './stripe.service';
import type { StripeClient } from './stripe.types';

interface MockStripe {
  paymentIntents: { create: jest.Mock };
  refunds: { create: jest.Mock };
  customers: { create: jest.Mock };
  webhooks: { constructEvent: jest.Mock };
}

function mockStripe(): MockStripe {
  return {
    paymentIntents: { create: jest.fn() },
    refunds: { create: jest.fn() },
    customers: { create: jest.fn() },
    webhooks: { constructEvent: jest.fn() },
  };
}

const ORIGINAL_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
afterEach(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
  else process.env.STRIPE_WEBHOOK_SECRET = ORIGINAL_SECRET;
});

describe('StripeService — createPaymentIntent', () => {
  it('passes server amount + lowercased currency + metadata + customer, with idempotency key', async () => {
    const stripe = mockStripe();
    stripe.paymentIntents.create.mockResolvedValue({
      id: 'pi_123',
      client_secret: 'pi_123_secret',
      status: 'requires_payment_method',
    });
    const svc = new StripeService(stripe as unknown as StripeClient);

    const res = await svc.createPaymentIntent({
      amount: 1999,
      currency: 'EUR',
      customerId: 'cus_42',
      metadata: { orderId: 'o1', tenantId: 't1' },
      idempotencyKey: 'o1',
    });

    expect(res).toEqual({
      id: 'pi_123',
      clientSecret: 'pi_123_secret',
      status: 'requires_payment_method',
    });
    const [body, opts] = stripe.paymentIntents.create.mock.calls[0];
    expect(body).toMatchObject({
      amount: 1999,
      currency: 'eur',
      customer: 'cus_42',
      metadata: { orderId: 'o1', tenantId: 't1' },
      automatic_payment_methods: { enabled: true },
    });
    expect(opts).toEqual({ idempotencyKey: 'o1' });
  });

  it('omits customer for a guest one-off intent', async () => {
    const stripe = mockStripe();
    stripe.paymentIntents.create.mockResolvedValue({ id: 'pi_g', client_secret: 's', status: 'x' });
    const svc = new StripeService(stripe as unknown as StripeClient);
    await svc.createPaymentIntent({
      amount: 500,
      currency: 'usd',
      customerId: null,
      metadata: {},
      idempotencyKey: 'o2',
    });
    expect(stripe.paymentIntents.create.mock.calls[0][0].customer).toBeUndefined();
  });

  it('throws 503 when Stripe is not configured (null client)', async () => {
    const svc = new StripeService(null);
    expect(svc.isConfigured).toBe(false);
    await expect(
      svc.createPaymentIntent({ amount: 1, currency: 'eur', metadata: {}, idempotencyKey: 'k' }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

describe('StripeService — ensureCustomer + createRefund', () => {
  it('creates a customer with idempotency key and returns its id', async () => {
    const stripe = mockStripe();
    stripe.customers.create.mockResolvedValue({ id: 'cus_new' });
    const svc = new StripeService(stripe as unknown as StripeClient);
    const id = await svc.ensureCustomer({
      email: 'a@b.com',
      name: 'A',
      metadata: { customerId: 'c1' },
      idempotencyKey: 'cust:t1:c1',
    });
    expect(id).toBe('cus_new');
    expect(stripe.customers.create.mock.calls[0][1]).toEqual({ idempotencyKey: 'cust:t1:c1' });
  });

  it('refund passes payment_intent + amount + idempotency key', async () => {
    const stripe = mockStripe();
    stripe.refunds.create.mockResolvedValue({ id: 're_1', status: 'succeeded' });
    const svc = new StripeService(stripe as unknown as StripeClient);
    const r = await svc.createRefund({
      paymentIntentId: 'pi_1',
      amount: 100,
      currency: 'eur',
      idempotencyKey: 'rf1',
    });
    expect(r).toEqual({ id: 're_1', status: 'succeeded' });
    expect(stripe.refunds.create.mock.calls[0][0]).toMatchObject({
      payment_intent: 'pi_1',
      amount: 100,
    });
  });
});

describe('StripeService — constructWebhookEvent (fail-closed)', () => {
  it('verifies with the signing secret and returns the parsed event', () => {
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
    const stripe = mockStripe();
    const event = { id: 'evt_1', type: 'payment_intent.succeeded' };
    stripe.webhooks.constructEvent.mockReturnValue(event);
    const svc = new StripeService(stripe as unknown as StripeClient);

    const out = svc.constructWebhookEvent(Buffer.from('{}'), 'sig');
    expect(out).toBe(event);
    expect(stripe.webhooks.constructEvent).toHaveBeenCalledWith(
      expect.any(Buffer),
      'sig',
      'whsec_test',
    );
  });

  it('rejects a missing signature with 400', () => {
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
    const stripe = mockStripe();
    const svc = new StripeService(stripe as unknown as StripeClient);
    expect(() => svc.constructWebhookEvent(Buffer.from('{}'), undefined)).toThrow(
      BadRequestException,
    );
    expect(stripe.webhooks.constructEvent).not.toHaveBeenCalled();
  });

  it('rejects an invalid signature with 400 and leaks no detail', () => {
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
    const stripe = mockStripe();
    stripe.webhooks.constructEvent.mockImplementation(() => {
      throw new Error('No signatures found matching the expected signature for payload');
    });
    const svc = new StripeService(stripe as unknown as StripeClient);
    expect(() => svc.constructWebhookEvent(Buffer.from('{}'), 'bad')).toThrow(
      'Invalid webhook signature',
    );
  });

  it('fails closed (503) when no signing secret is configured', () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const stripe = mockStripe();
    const svc = new StripeService(stripe as unknown as StripeClient);
    expect(() => svc.constructWebhookEvent(Buffer.from('{}'), 'sig')).toThrow(
      ServiceUnavailableException,
    );
  });
});
