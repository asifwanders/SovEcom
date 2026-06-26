/**
 * invoice PDF renderer unit tests.
 *
 * Pins the MINOR-UNITS-AWARE money: a zero-decimal currency (JPY) must render
 * UN-divided (1000 minor = ¥1,000, not ¥10), a 3-decimal currency (KWD) divides by 1000, and
 * EUR divides by 100. Also asserts the discount + shipping lines are typeset.
 *
 * pdfkit (compress:false) hex-encodes glyphs into the content stream; we decode every <hex>
 * chunk into one searchable string (mirrors the integration harness' extractPdfText).
 */
import { renderInvoicePdf, type InvoicePdfHeader } from './invoice-pdf';
import type { BuyerSnapshot, InvoiceContent, SellerSnapshot } from './invoice-snapshot';

function extractPdfText(bytes: Buffer): string {
  const raw = bytes.toString('latin1');
  let out = '';
  for (const m of raw.matchAll(/<([0-9A-Fa-f]+)>/g)) {
    const hex = m[1]!;
    for (let i = 0; i + 1 < hex.length; i += 2) {
      out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
    }
  }
  return out;
}

const HEADER: InvoicePdfHeader = {
  invoiceNumber: '2026-000001',
  series: 'STD',
  issuedAt: new Date('2026-06-12T00:00:00Z'),
  orderNumber: '1001',
};

const SELLER: SellerSnapshot = {
  name: 'Acme SARL',
  address: {
    name: 'Acme SARL',
    line1: '10 rue',
    city: 'Paris',
    postalCode: '75001',
    country: 'FR',
  },
  siren: '123456789',
  vatNumber: 'FR12345678901',
  country: 'FR',
};

const BUYER: BuyerSnapshot = {
  name: 'Jane Buyer',
  email: 'buyer@example.com',
  address: { name: 'Jane Buyer', line1: '2 Way', city: 'Lyon', postalCode: '69001', country: 'FR' },
  vatNumber: null,
  isB2b: false,
};

function content(overrides: Partial<InvoiceContent> = {}): InvoiceContent {
  return {
    taxMode: 'eu_vat',
    documentKind: 'vat_invoice',
    taxInclusive: false,
    currency: 'EUR',
    lines: [
      {
        description: 'Widget',
        sku: 'WID-1',
        quantity: 1,
        unitPriceAmount: 1000,
        taxRate: 0.2,
        lineNetAmount: 1000,
        lineTaxAmount: 200,
      },
    ],
    subtotalAmount: 1000,
    discount: { netAmount: 0 },
    shipping: { netAmount: 0, taxAmount: 0, taxRate: 0 },
    taxAmount: 200,
    totalAmount: 1200,
    taxBreakdown: [{ rate: 0.2, baseAmount: 1000, taxAmount: 200 }],
    reverseCharge: false,
    viesConsultationRef: null,
    mentions: [],
    ...overrides,
  };
}

describe('invoice-pdf money() — minor-units-aware', () => {
  it('renders a JPY (zero-decimal) amount UN-divided: 1000 minor → 1000 JPY, never 10', async () => {
    const bytes = await renderInvoicePdf(
      HEADER,
      content({
        currency: 'JPY',
        lines: [
          {
            description: 'Widget',
            sku: 'WID-1',
            quantity: 1,
            unitPriceAmount: 1000,
            taxRate: 0,
            lineNetAmount: 1000,
            lineTaxAmount: 0,
          },
        ],
        documentKind: 'receipt',
        taxMode: 'none',
        subtotalAmount: 1000,
        taxAmount: 0,
        totalAmount: 1000,
        taxBreakdown: [],
        mentions: [],
      }),
      SELLER,
      BUYER,
    );
    const text = extractPdfText(bytes);
    // The total prints "1000 JPY" (un-divided) — NOT "10.00" or "10 JPY".
    expect(text).toContain('1000 JPY');
    expect(text).not.toContain('10.00 JPY');
    expect(text).not.toMatch(/\b10 JPY\b/);
  });

  it('renders a KWD (3-decimal) amount divided by 1000: 1234 minor → 1.234 KWD', async () => {
    const bytes = await renderInvoicePdf(
      HEADER,
      content({
        currency: 'KWD',
        documentKind: 'receipt',
        taxMode: 'none',
        lines: [
          {
            description: 'Widget',
            sku: 'WID-1',
            quantity: 1,
            unitPriceAmount: 1234,
            taxRate: 0,
            lineNetAmount: 1234,
            lineTaxAmount: 0,
          },
        ],
        subtotalAmount: 1234,
        taxAmount: 0,
        totalAmount: 1234,
        taxBreakdown: [],
        mentions: [],
      }),
      SELLER,
      BUYER,
    );
    const text = extractPdfText(bytes);
    expect(text).toContain('1.234 KWD');
  });

  it('renders EUR divided by 100: 1200 minor → 12.00 EUR', async () => {
    const bytes = await renderInvoicePdf(HEADER, content(), SELLER, BUYER);
    const text = extractPdfText(bytes);
    expect(text).toContain('12.00 EUR');
  });
});

describe('invoice-pdf — itemises discount + shipping (B1)', () => {
  it('prints a Discount line and a Shipping (net) line with its VAT', async () => {
    const bytes = await renderInvoicePdf(
      HEADER,
      content({
        subtotalAmount: 1000,
        discount: { netAmount: 100 },
        shipping: { netAmount: 300, taxAmount: 60, taxRate: 0.2 },
        // goods-after-discount net 900 @20% = 180; shipping 60. total tax 240.
        lines: [
          {
            description: 'Widget',
            sku: 'WID-1',
            quantity: 1,
            unitPriceAmount: 1000,
            taxRate: 0.2,
            lineNetAmount: 900,
            lineTaxAmount: 180,
          },
        ],
        taxAmount: 240,
        totalAmount: 1440,
        taxBreakdown: [{ rate: 0.2, baseAmount: 1200, taxAmount: 240 }],
      }),
      SELLER,
      BUYER,
    );
    const text = extractPdfText(bytes);
    expect(text).toContain('Discount');
    expect(text).toContain('Shipping');
    // The discount + shipping figures render.
    expect(text).toContain('1.00 EUR'); // discount 100
    expect(text).toContain('3.00 EUR'); // shipping net 300
    expect(text).toContain('14.40 EUR'); // total 1440
  });
});
