/**
 * RgpdService EXPORT completeness UNIT tests (Art. 15/20).
 *
 * The erase path (CustomersRepository.erase) proves that more PII than the
 * profile+addresses is held for a customer: order `email` + shipping/billing
 * address SNAPSHOTS, and `email_logs.recipient`. Art. 15 requires the export to
 * DISCLOSE all of that personal data. These tests pin:
 *   - the export envelope CONTAINS the customer's orders (number + integer-cents
 *     total + currency + line items + address snapshots),
 *   - it CONTAINS invoices metadata and email-log metadata (recipient + type +
 *     timestamp),
 *   - it does NOT leak another customer's data (the repository is queried
 *     strictly tenant + customer scoped),
 *   - it remains an ALLOWLIST (no secret/internal columns leak through).
 *
 * Repositories are mocked — the step-up gate (argon2/rate-limit) is exercised
 * elsewhere; here a successful step-up is stubbed so the test targets the
 * serialization/enumeration of personal data.
 */
import { RgpdService } from './rgpd.service';

const TENANT = 'tenant-1';
const ME = 'cust-1';
const OTHER = 'cust-2';

function makeCustomer(id: string, email: string) {
  return {
    id,
    tenantId: TENANT,
    email,
    passwordHash: 'argon2-hash-SECRET',
    name: 'Alice Doe',
    phone: '+33100000000',
    isB2b: false,
    vatNumber: null,
    vatValidated: false,
    vatValidatedAt: null,
    taxExempt: false,
    totpSecret: 'TOTP-SECRET',
    totpEnabled: false,
    acceptsMarketing: true,
    locale: 'fr',
    stripeCustomerId: 'cus_SECRET',
    metadata: { vat: { proof: 'SECRET' } },
    anonymizedAt: null,
    deletedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
  };
}

function makeService(overrides?: {
  orders?: unknown[];
  invoices?: unknown[];
  emailLogs?: unknown[];
}) {
  const myCustomer = makeCustomer(ME, 'alice@example.com');

  const customers = {
    findActiveById: jest.fn().mockResolvedValue(myCustomer),
    listOrdersForExport: jest.fn().mockResolvedValue(
      overrides?.orders ?? [
        {
          order: {
            id: 'order-1',
            orderNumber: 'ORD-1001',
            status: 'paid',
            currency: 'EUR',
            subtotalAmount: 9000,
            discountAmount: 0,
            shippingAmount: 500,
            taxAmount: 1900,
            totalAmount: 11400,
            refundedAmount: 0,
            email: 'alice@example.com',
            shippingAddress: { name: 'Alice Doe', line1: '1 rue de Paris', country: 'FR' },
            billingAddress: { name: 'Alice Doe', line1: '1 rue de Paris', country: 'FR' },
            placedAt: new Date('2026-02-01T10:00:00.000Z'),
            createdAt: new Date('2026-02-01T09:59:00.000Z'),
            // internal/system columns that MUST NOT leak:
            guestTokenHash: 'sha256-SECRET',
            metadata: { internal: 'SECRET' },
          },
          items: [
            {
              id: 'item-1',
              productTitle: 'Widget',
              variantTitle: 'Blue',
              sku: 'WID-BLU',
              quantity: 2,
              unitPriceAmount: 4500,
              taxRate: '0.2000',
              taxAmount: 1900,
              lineTotalAmount: 9000,
            },
          ],
        },
      ],
    ),
    listInvoicesForExport: jest.fn().mockResolvedValue(
      overrides?.invoices ?? [
        {
          id: 'inv-1',
          orderId: 'order-1',
          type: 'invoice',
          series: 'STD',
          invoiceNumber: '2026-000001',
          issuedAt: new Date('2026-02-01T10:05:00.000Z'),
          currency: 'EUR',
          totalAmount: 11400,
          // internal snapshot columns that MUST NOT leak:
          sellerSnapshot: { secret: true },
          storageKey: 'invoices/SECRET.pdf',
        },
      ],
    ),
    listEmailLogsForExport: jest.fn().mockResolvedValue(
      overrides?.emailLogs ?? [
        {
          id: 'mail-1',
          recipient: 'alice@example.com',
          type: 'order_confirmation',
          subject: 'Your order ORD-1001',
          status: 'sent',
          sentAt: new Date('2026-02-01T10:06:00.000Z'),
          createdAt: new Date('2026-02-01T10:06:00.000Z'),
          // transport internals that MUST NOT leak:
          providerMessageId: 'msg-SECRET',
          error: null,
        },
      ],
    ),
  };

  const addresses = {
    listForCustomer: jest.fn().mockResolvedValue([]),
  };

  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const passwords = {
    verify: jest.fn().mockResolvedValue(true),
    dummyVerify: jest.fn().mockResolvedValue(undefined),
  };
  const rateLimit = { check: jest.fn().mockResolvedValue({ allowed: true }) };

  const svc = new RgpdService(
    customers as never,
    addresses as never,
    audit as never,
    passwords as never,
    rateLimit as never,
  );
  return { svc, customers, addresses, audit };
}

describe('RgpdService.exportOwnData — Art.15/20 completeness (R1)', () => {
  it('includes the customer orders with number + integer-cents total + currency + line items + address snapshots', async () => {
    const { svc } = makeService();
    const out = await svc.exportOwnData(TENANT, ME, 'pw', {});

    expect(Array.isArray(out.orders)).toBe(true);
    expect(out.orders.length).toBeGreaterThanOrEqual(1);
    const order = out.orders[0]!;
    expect(order.orderNumber).toBe('ORD-1001');
    expect(order.totalAmount).toBe(11400);
    expect(Number.isInteger(order.totalAmount)).toBe(true);
    expect(order.currency).toBe('EUR');
    expect(order.shippingAddress).toMatchObject({ country: 'FR' });
    expect(order.billingAddress).toMatchObject({ country: 'FR' });
    expect(order.items.length).toBe(1);
    expect(order.items[0]).toMatchObject({ sku: 'WID-BLU', quantity: 2, lineTotalAmount: 9000 });
  });

  it('includes invoices metadata (number + total) for the customer', async () => {
    const { svc } = makeService();
    const out = await svc.exportOwnData(TENANT, ME, 'pw', {});

    expect(Array.isArray(out.invoices)).toBe(true);
    expect(out.invoices.length).toBeGreaterThanOrEqual(1);
    expect(out.invoices[0]).toMatchObject({
      invoiceNumber: '2026-000001',
      totalAmount: 11400,
      currency: 'EUR',
    });
  });

  it('includes email-log metadata (recipient + type + timestamp)', async () => {
    const { svc } = makeService();
    const out = await svc.exportOwnData(TENANT, ME, 'pw', {});

    expect(Array.isArray(out.emailLogs)).toBe(true);
    expect(out.emailLogs.length).toBeGreaterThanOrEqual(1);
    const log = out.emailLogs[0]!;
    expect(log.recipient).toBe('alice@example.com');
    expect(log.type).toBe('order_confirmation');
    expect(typeof log.sentAt).toBe('string');
  });

  it('is an ALLOWLIST — no secret/internal columns leak through any section', async () => {
    const { svc } = makeService();
    const out = await svc.exportOwnData(TENANT, ME, 'pw', {});
    const blob = JSON.stringify(out);

    expect(blob).not.toContain('SECRET');
    // No raw order/invoice/email internals.
    const order0 = out.orders[0] as unknown as Record<string, unknown>;
    const inv0 = out.invoices[0] as unknown as Record<string, unknown>;
    const mail0 = out.emailLogs[0] as unknown as Record<string, unknown>;
    expect(order0.guestTokenHash).toBeUndefined();
    expect(order0.metadata).toBeUndefined();
    expect(inv0.sellerSnapshot).toBeUndefined();
    expect(inv0.storageKey).toBeUndefined();
    expect(mail0.providerMessageId).toBeUndefined();
  });

  it('queries the repositories strictly scoped to the caller (tenant + customer) — no other customer leak', async () => {
    const { svc, customers, addresses } = makeService();
    await svc.exportOwnData(TENANT, ME, 'pw', {});

    expect(customers.listOrdersForExport).toHaveBeenCalledWith(TENANT, ME);
    expect(customers.listInvoicesForExport).toHaveBeenCalledWith(TENANT, ME);
    // email logs are keyed on the caller's OWN current email, tenant-scoped.
    expect(customers.listEmailLogsForExport).toHaveBeenCalledWith(TENANT, 'alice@example.com');
    expect(addresses.listForCustomer).toHaveBeenCalledWith(TENANT, ME);

    // Never queried with the other customer's id / a cross-tenant value.
    for (const call of customers.listOrdersForExport.mock.calls) {
      expect(call[0]).toBe(TENANT);
      expect(call[1]).toBe(ME);
      expect(call).not.toContain(OTHER);
    }
  });

  it('returns empty sections (not undefined) for a customer with no orders/invoices/emails', async () => {
    const { svc } = makeService({ orders: [], invoices: [], emailLogs: [] });
    const out = await svc.exportOwnData(TENANT, ME, 'pw', {});

    expect(out.orders).toEqual([]);
    expect(out.invoices).toEqual([]);
    expect(out.emailLogs).toEqual([]);
  });
});
