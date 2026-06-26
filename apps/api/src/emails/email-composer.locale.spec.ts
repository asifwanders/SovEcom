/**
 * EmailComposer locale resolution.
 *
 * Verifies the composer resolves the render locale from `customers.locale` and falls back
 * to the default ('en') for null / unknown / guest / repo-failure — null-safe and total,
 * so the order-email path is never blocked by locale resolution. Repos are mocked (no DB).
 */
import { EmailComposer } from './email-composer.service';
import type { OrderRepository } from '../orders/order.repository';
import type { RefundRepository } from '../payments/refunds/refund.repository';
import type { InvoiceService } from '../invoices/invoice.service';
import type { CustomersRepository } from '../customers/customers.repository';
import type { Order } from '../database/schema/orders';
import type { Customer } from '../database/schema/customers';

const TENANT = '00000000-0000-0000-0000-0000000000aa';
const ORDER_ID = '00000000-0000-0000-0000-0000000000b0';
const CUSTOMER_ID = '00000000-0000-0000-0000-0000000000c0';

function makeOrder(over: Partial<Order> = {}): Order {
  return {
    orderNumber: 'SO-1001',
    email: 'cust@example.invalid',
    currency: 'EUR',
    customerId: CUSTOMER_ID,
    subtotalAmount: 2000,
    discountAmount: 0,
    shippingAmount: 500,
    taxAmount: 400,
    totalAmount: 2900,
    shippingAddress: null,
    ...over,
  } as unknown as Order;
}

function makeComposer(opts: {
  order?: Order | null;
  customer?: Customer | null;
  customerThrows?: boolean;
}): { composer: EmailComposer; customerSpy: jest.Mock } {
  const orders = {
    findById: jest.fn(async () => opts.order ?? null),
    itemsForOrder: jest.fn(async () => [
      {
        productTitle: 'Widget',
        sku: 'WID-1',
        quantity: 2,
        unitPriceAmount: 1000,
        lineTotalAmount: 2000,
      },
    ]),
  } as unknown as OrderRepository;
  const refunds = {} as unknown as RefundRepository;
  const invoices = {} as unknown as InvoiceService;
  const customerSpy = jest.fn(async () => {
    if (opts.customerThrows) throw new Error('db down');
    return opts.customer ?? null;
  });
  const customers = { findActiveById: customerSpy } as unknown as CustomersRepository;
  return { composer: new EmailComposer(orders, refunds, invoices, customers), customerSpy };
}

describe('EmailComposer — locale resolution', () => {
  it("customer.locale='fr' → FRENCH subject + body", async () => {
    const { composer } = makeComposer({
      order: makeOrder(),
      customer: { locale: 'fr' } as Customer,
    });
    const out = await composer.compose(TENANT, 'order_confirmation', ORDER_ID, null);
    expect(out!.rendered.subject).toBe('Commande SO-1001 confirmée');
    expect(out!.rendered.text).toContain('Merci pour votre commande');
    // DATA preserved regardless of locale.
    expect(out!.rendered.text).toContain('SO-1001');
    expect(out!.rendered.text).toContain('29.00 EUR');
  });

  it("customer.locale='en' → ENGLISH", async () => {
    const { composer } = makeComposer({
      order: makeOrder(),
      customer: { locale: 'en' } as Customer,
    });
    const out = await composer.compose(TENANT, 'order_confirmation', ORDER_ID, null);
    expect(out!.rendered.subject).toBe('Order SO-1001 confirmed');
  });

  it('customer.locale=null → ENGLISH (fallback, never blocks send)', async () => {
    const { composer } = makeComposer({
      order: makeOrder(),
      customer: { locale: null } as Customer,
    });
    const out = await composer.compose(TENANT, 'order_confirmation', ORDER_ID, null);
    expect(out!.rendered.subject).toBe('Order SO-1001 confirmed');
  });

  it('unrecognized locale → ENGLISH (fallback, no throw)', async () => {
    const { composer } = makeComposer({
      order: makeOrder(),
      customer: { locale: 'de' } as Customer,
    });
    const out = await composer.compose(TENANT, 'order_confirmation', ORDER_ID, null);
    expect(out!.rendered.subject).toBe('Order SO-1001 confirmed');
  });

  it('guest order (customerId null) → ENGLISH, no customer lookup', async () => {
    const { composer, customerSpy } = makeComposer({
      order: makeOrder({ customerId: null } as Partial<Order>),
    });
    const out = await composer.compose(TENANT, 'order_confirmation', ORDER_ID, null);
    expect(out!.rendered.subject).toBe('Order SO-1001 confirmed');
    expect(customerSpy).not.toHaveBeenCalled();
  });

  it('customer lookup THROWS → ENGLISH (degrades, never blocks the order email)', async () => {
    const { composer } = makeComposer({ order: makeOrder(), customerThrows: true });
    const out = await composer.compose(TENANT, 'order_confirmation', ORDER_ID, null);
    expect(out).not.toBeNull();
    expect(out!.rendered.subject).toBe('Order SO-1001 confirmed');
  });
});
