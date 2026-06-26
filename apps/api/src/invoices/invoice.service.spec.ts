/**
 * InvoiceService UNIT tests (mock repo/db/storage).
 * MONEY/LEGAL-CRITICAL.
 *
 * `issueForOrder` must gate on the TRUE invariant (money captured), not a strict
 * `status === 'paid'` whitelist. `order.paid` is emitted post-commit async; a fast
 * secondary transition (paid → fulfilled/…/refunded) before the listener runs must
 * NOT make issuance refuse and lose the one-shot event. Only a `pending_payment`
 * order (money not captured) is refused.
 *
 * The snapshot + PDF modules are mocked so the test exercises the GATE, not the
 * (separately-tested) snapshot/render machinery.
 */
import { ConflictException } from '@nestjs/common';
import { InvoiceService } from './invoice.service';

jest.mock('./invoice-snapshot', () => ({
  buildInvoiceContent: () => ({
    currency: 'EUR',
    subtotalAmount: 1000,
    taxAmount: 200,
    totalAmount: 1200,
    reverseCharge: false,
    viesConsultationRef: null,
  }),
}));
jest.mock('./invoice-pdf', () => ({ renderInvoicePdf: async () => Buffer.from('') }));

type Status =
  | 'pending_payment'
  | 'paid'
  | 'fulfilled'
  | 'shipped'
  | 'delivered'
  | 'completed'
  | 'cancelled'
  | 'refunded'
  | 'partially_refunded';

function makeService(status: Status): {
  svc: InvoiceService;
  allocate: jest.Mock;
} {
  const order = {
    id: 'order-1',
    tenantId: 'tenant-1',
    status,
    currency: 'EUR',
    customerId: null,
    vatNumber: null,
    reverseCharge: false,
  };

  const allocate = jest.fn().mockResolvedValue(1n);
  const insertedInvoice = {
    id: 'inv-1',
    storageKey: null,
    series: 'STD',
    invoiceNumber: '2026-000001',
  };

  const repo = {
    findInvoiceForOrder: jest.fn().mockResolvedValue(null),
    loadOrder: jest.fn().mockResolvedValue(order),
    loadOrderItems: jest.fn().mockResolvedValue([]),
    allocateGaplessNumber: allocate,
    insertInvoice: jest.fn().mockResolvedValue(insertedInvoice),
    attachStorageKey: jest.fn().mockResolvedValue(false),
  };

  // `loadSellerIdentity` issues a `select().from().where().limit()` for the tenant
  // identity row; return an empty result (the service falls back to defaults).
  const selectChain = {
    from: () => selectChain,
    where: () => selectChain,
    limit: async () => [] as unknown[],
  };
  const db = {
    db: {
      select: () => selectChain,
      transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb({}),
    },
  };
  const storage = { upload: jest.fn(), download: jest.fn() };
  const tenantSettings = { getTaxSettings: jest.fn().mockResolvedValue({ taxMode: 'none' }) };

  const svc = new InvoiceService(
    db as never,
    repo as never,
    storage as never,
    tenantSettings as never,
  );
  return { svc, allocate };
}

describe('InvoiceService.issueForOrder — payment-captured gate (MONEY-CRITICAL)', () => {
  it('REFUSES a pending_payment order (money not captured)', async () => {
    const { svc, allocate } = makeService('pending_payment');
    await expect(svc.issueForOrder('tenant-1', 'order-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(allocate).not.toHaveBeenCalled();
  });

  it.each<Status>([
    'paid',
    'fulfilled',
    'shipped',
    'delivered',
    'completed',
    'refunded',
    'partially_refunded',
  ])('ISSUES for a post-payment status (%s) — the one-shot event is not lost', async (status) => {
    const { svc, allocate } = makeService(status);
    const result = await svc.issueForOrder('tenant-1', 'order-1');
    expect(result.created).toBe(true);
    expect(allocate).toHaveBeenCalledTimes(1);
  });
});
