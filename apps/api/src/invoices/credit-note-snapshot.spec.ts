/**
 * buildCreditNoteContent unit tests. Pure money/format checks.
 */
import {
  buildCreditNoteContent,
  CREDIT_NOTE_MENTION,
  NO_VAT_MENTION,
  REVERSE_CHARGE_MENTION,
  type CreditNoteInput,
} from './invoice-snapshot';

function base(over: Partial<CreditNoteInput> = {}): CreditNoteInput {
  return {
    taxMode: 'eu_vat',
    currency: 'EUR',
    taxInclusive: false,
    reverseCharge: false,
    lines: [
      {
        description: 'Widget',
        sku: 'W1',
        quantity: 2,
        netAmount: 1000,
        taxRate: 0.2,
        taxAmount: 200,
      },
    ],
    shippingNet: 0,
    shippingTax: 0,
    shippingRate: 0,
    netAmount: 1000,
    taxAmount: 200,
    totalAmount: 1200,
    correctsInvoiceNumber: '2026-000001',
    ...over,
  };
}

describe('buildCreditNoteContent', () => {
  it('builds a VAT credit note that reconciles (net + shipping + VAT == total)', () => {
    const c = buildCreditNoteContent(base());
    expect(c.isCreditNote).toBe(true);
    expect(c.documentKind).toBe('vat_invoice');
    expect(c.subtotalAmount).toBe(1000);
    expect(c.taxAmount).toBe(200);
    expect(c.totalAmount).toBe(1200);
    expect(c.correctsInvoiceNumber).toBe('2026-000001');
    expect(c.taxBreakdown).toEqual([{ rate: 0.2, baseAmount: 1000, taxAmount: 200 }]);
    expect(c.mentions).toContain(CREDIT_NOTE_MENTION);
  });

  it('includes a refunded shipping contribution in the recap', () => {
    const c = buildCreditNoteContent(
      base({
        shippingNet: 500,
        shippingTax: 100,
        shippingRate: 0.2,
        netAmount: 1500,
        taxAmount: 300,
        totalAmount: 1800,
      }),
    );
    expect(c.totalAmount).toBe(1800);
    expect(c.taxBreakdown).toEqual([{ rate: 0.2, baseAmount: 1500, taxAmount: 300 }]);
  });

  it('none regime → receipt-style, no VAT, NO_VAT mention', () => {
    const c = buildCreditNoteContent(
      base({
        taxMode: 'none',
        lines: [
          { description: 'X', sku: 'X', quantity: 1, netAmount: 1000, taxRate: 0, taxAmount: 0 },
        ],
        taxAmount: 0,
        totalAmount: 1000,
      }),
    );
    expect(c.documentKind).toBe('receipt');
    expect(c.taxAmount).toBe(0);
    expect(c.taxBreakdown).toEqual([]);
    expect(c.mentions).toContain(NO_VAT_MENTION);
  });

  it('reverse charge → single 0% recap row + autoliquidation mention', () => {
    const c = buildCreditNoteContent(
      base({
        reverseCharge: true,
        lines: [
          { description: 'X', sku: 'X', quantity: 1, netAmount: 1000, taxRate: 0, taxAmount: 0 },
        ],
        taxAmount: 0,
        totalAmount: 1000,
      }),
    );
    expect(c.taxBreakdown).toEqual([{ rate: 0, baseAmount: 1000, taxAmount: 0 }]);
    expect(c.mentions).toContain(REVERSE_CHARGE_MENTION);
  });

  it('throws when the figures do not reconcile', () => {
    expect(() => buildCreditNoteContent(base({ totalAmount: 9999 }))).toThrow(/reconcile/);
  });
});
