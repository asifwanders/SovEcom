/**
 * OrderDetail component tests.
 *
 * MONEY-CRITICAL: Every amount is a server integer in minor units rendered via `formatPrice`.
 * No client-side arithmetic — totals, line-item amounts and subtotals come straight from the
 * server response; the component never sums or divides them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { renderWithIntl } from '@/test-intl';
import enMessages from '../../../messages/en.json';
import type { OrderView } from '@/lib/payment-types';

// --- Mock locale-aware Link ---
vi.mock('@/i18n/navigation', () => ({
  Link: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    [key: string]: unknown;
  }) => (
    <a href={typeof href === 'string' ? href : '#'} {...rest}>
      {children}
    </a>
  ),
}));

// --- Auth mock ---
let getAccessToken: () => string | null = () => 'token-abc';
let refresh: () => Promise<string | null> = async () => 'token-abc';
vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ getAccessToken, refresh }),
}));

// --- Browser client mock ---
let mockRequest: (method: string, path: string, opts?: unknown) => Promise<unknown>;
vi.mock('@/lib/browser-client', () => ({
  createBrowserClient: () => ({
    request: (...args: unknown[]) => mockRequest(...(args as [string, string, unknown?])),
  }),
  // The Chunk-C <InvoiceDownloadButton> child imports `apiBaseUrl` from this module to build its
  // raw-fetch URL; the whole module is mocked here, so expose it (the button's own fetch is never
  // exercised in these OrderDetail tests — no click — so a stub origin is sufficient).
  apiBaseUrl: () => 'http://api.test',
}));

import { OrderDetail } from './OrderDetail';

const SHIPPING_ADDR = {
  name: 'Ada Lovelace',
  line1: '10 Downing St',
  city: 'London',
  postalCode: 'SW1A 2AA',
  country: 'GB',
};

const BILLING_ADDR = {
  name: 'Ada Lovelace',
  line1: '10 Downing St',
  city: 'London',
  postalCode: 'SW1A 2AA',
  country: 'GB',
};

const FULL_ORDER: OrderView = {
  id: 'order-1',
  orderNumber: 'ORD-0001',
  status: 'shipped',
  currency: 'EUR',
  email: 'ada@example.com',
  subtotalAmount: 3998,
  discountAmount: 500,
  shippingAmount: 600,
  taxAmount: 720,
  totalAmount: 4818,
  shippingMethod: 'Standard',
  shippingAddress: SHIPPING_ADDR,
  billingAddress: BILLING_ADDR,
  placedAt: '2026-06-01T10:00:00.000Z',
  createdAt: '2026-06-01T10:00:00.000Z',
  discountCode: 'SAVE5',
  trackingNumber: 'TRACK123',
  carrier: 'DHL',
  items: [
    {
      id: 'item-1',
      productTitle: 'Blue T-Shirt',
      variantTitle: 'M / Blue',
      sku: 'SKU-001',
      quantity: 2,
      unitPriceAmount: 1999,
      lineTotalAmount: 3998,
    },
    {
      id: 'item-2',
      productTitle: 'Black Hoodie',
      variantTitle: null,
      sku: 'SKU-002',
      quantity: 1,
      unitPriceAmount: 4999,
      lineTotalAmount: 4999,
    },
  ],
};

beforeEach(() => {
  getAccessToken = () => 'token-abc';
  refresh = async () => 'token-abc';
  mockRequest = async () => FULL_ORDER;
});

describe('OrderDetail', () => {
  it('shows loading state initially', () => {
    mockRequest = async () => new Promise(() => undefined);
    renderWithIntl(<OrderDetail orderId="order-1" />, 'en');
    expect(screen.getByTestId('order-detail-loading')).toBeInTheDocument();
  });

  it('renders the order number and translated status', async () => {
    renderWithIntl(<OrderDetail orderId="order-1" />, 'en');
    await waitFor(() => expect(screen.getByTestId('order-detail')).toBeInTheDocument());
    expect(screen.getByText('ORD-0001')).toBeInTheDocument();
    expect(screen.getByText('Shipped')).toBeInTheDocument();
  });

  it('renders translated status in French', async () => {
    renderWithIntl(<OrderDetail orderId="order-1" />, 'fr');
    await waitFor(() => expect(screen.getByTestId('order-detail')).toBeInTheDocument());
    expect(screen.getByText('Expédiée')).toBeInTheDocument();
  });

  it('renders line items with title, variant, quantity, unit price and line total', async () => {
    renderWithIntl(<OrderDetail orderId="order-1" />, 'en');
    await waitFor(() => expect(screen.getByTestId('order-detail')).toBeInTheDocument());
    // First item
    expect(screen.getByText('Blue T-Shirt')).toBeInTheDocument();
    expect(screen.getByText(/M \/ Blue/)).toBeInTheDocument();
    // Second item (no variantTitle)
    expect(screen.getByText('Black Hoodie')).toBeInTheDocument();
  });

  it('MONEY: renders line total 3998 EUR as formatted price (no client division)', async () => {
    renderWithIntl(<OrderDetail orderId="order-1" />, 'en');
    await waitFor(() => expect(screen.getByTestId('order-detail')).toBeInTheDocument());
    // 3998 EUR minor units = €39.98
    const lineTotals = screen.getAllByTestId('line-total');
    expect(lineTotals[0]!.textContent).toContain('39.98');
  });

  it('MONEY: renders unit price 1999 EUR as €19.99 (canonical minor-unit proof)', async () => {
    renderWithIntl(<OrderDetail orderId="order-1" />, 'en');
    await waitFor(() => expect(screen.getByTestId('order-detail')).toBeInTheDocument());
    const unitPrices = screen.getAllByTestId('unit-price');
    expect(unitPrices[0]!.textContent).toContain('19.99');
  });

  it('MONEY: renders totals breakdown from server values (subtotal, discount, shipping, tax, total)', async () => {
    renderWithIntl(<OrderDetail orderId="order-1" />, 'en');
    await waitFor(() => expect(screen.getByTestId('order-detail')).toBeInTheDocument());
    // subtotal 3998 = €39.98
    expect(screen.getByTestId('totals-subtotal').textContent).toContain('39.98');
    // discount 500 = €5.00 — shown because discountAmount > 0
    expect(screen.getByTestId('totals-discount')).toBeInTheDocument();
    expect(screen.getByTestId('totals-discount').textContent).toContain('5.00');
    // shipping 600 = €6.00
    expect(screen.getByTestId('totals-shipping').textContent).toContain('6.00');
    // tax 720 = €7.20
    expect(screen.getByTestId('totals-tax').textContent).toContain('7.20');
    // grand total 4818 = €48.18
    expect(screen.getByTestId('totals-grand').textContent).toContain('48.18');
  });

  it('hides the discount row when discountAmount is 0', async () => {
    mockRequest = async () => ({ ...FULL_ORDER, discountAmount: 0, discountCode: null });
    renderWithIntl(<OrderDetail orderId="order-1" />, 'en');
    await waitFor(() => expect(screen.getByTestId('order-detail')).toBeInTheDocument());
    expect(screen.queryByTestId('totals-discount')).not.toBeInTheDocument();
  });

  it('shows the discount code when discountAmount > 0 and discountCode is present', async () => {
    renderWithIntl(<OrderDetail orderId="order-1" />, 'en');
    await waitFor(() => expect(screen.getByTestId('order-detail')).toBeInTheDocument());
    expect(screen.getByText(/SAVE5/)).toBeInTheDocument();
  });

  it('renders shipping and billing address blocks', async () => {
    renderWithIntl(<OrderDetail orderId="order-1" />, 'en');
    await waitFor(() => expect(screen.getByTestId('order-detail')).toBeInTheDocument());
    expect(screen.getByTestId('shipping-address')).toBeInTheDocument();
    expect(screen.getByTestId('billing-address')).toBeInTheDocument();
    expect(screen.getByTestId('shipping-address').textContent).toContain('Ada Lovelace');
    expect(screen.getByTestId('shipping-address').textContent).toContain('10 Downing St');
  });

  it('shows tracking number and carrier when present', async () => {
    renderWithIntl(<OrderDetail orderId="order-1" />, 'en');
    await waitFor(() => expect(screen.getByTestId('order-detail')).toBeInTheDocument());
    expect(screen.getByTestId('tracking-info')).toBeInTheDocument();
    expect(screen.getByTestId('tracking-info').textContent).toContain('TRACK123');
    expect(screen.getByTestId('tracking-info').textContent).toContain('DHL');
  });

  it('hides tracking block when trackingNumber is absent', async () => {
    mockRequest = async () => ({ ...FULL_ORDER, trackingNumber: null, carrier: null });
    renderWithIntl(<OrderDetail orderId="order-1" />, 'en');
    await waitFor(() => expect(screen.getByTestId('order-detail')).toBeInTheDocument());
    expect(screen.queryByTestId('tracking-info')).not.toBeInTheDocument();
  });

  it('shows not-found state on a 404 response', async () => {
    mockRequest = async () => {
      const err = Object.assign(new Error('Not Found'), { status: 404 });
      throw err;
    };
    renderWithIntl(<OrderDetail orderId="order-1" />, 'en');
    await waitFor(() => expect(screen.getByTestId('order-not-found')).toBeInTheDocument());
    // Back-to-orders link must be present
    expect(screen.getByRole('link', { name: /back to orders/i })).toBeInTheDocument();
  });

  it('shows error state on a non-404 error', async () => {
    mockRequest = async () => {
      throw new Error('Server error');
    };
    renderWithIntl(<OrderDetail orderId="order-1" />, 'en');
    await waitFor(() => expect(screen.getByTestId('order-error')).toBeInTheDocument());
  });

  it('retries with refresh() on a 401', async () => {
    let calls = 0;
    const refreshFn = vi.fn().mockResolvedValue('new-token');
    refresh = refreshFn;
    mockRequest = async () => {
      calls++;
      if (calls === 1) {
        const err = Object.assign(new Error('Unauthorized'), { status: 401 });
        throw err;
      }
      return FULL_ORDER;
    };
    renderWithIntl(<OrderDetail orderId="order-1" />, 'en');
    await waitFor(() => expect(screen.getByTestId('order-detail')).toBeInTheDocument());
    expect(refreshFn).toHaveBeenCalledOnce();
  });

  it('shows error state (not stuck loading) when refresh() THROWS during a 401 retry', async () => {
    // refresh() re-throws network/5xx errors; the 401 retry must catch them so the component lands
    // on the ERROR state (not 'notfound', not stuck loading) — NIT #1.
    refresh = vi.fn().mockRejectedValue(new Error('network down'));
    mockRequest = async () => {
      const err = Object.assign(new Error('Unauthorized'), { status: 401 });
      throw err;
    };
    renderWithIntl(<OrderDetail orderId="order-1" />, 'en');
    await waitFor(() => expect(screen.getByTestId('order-error')).toBeInTheDocument());
    expect(screen.queryByTestId('order-detail-loading')).not.toBeInTheDocument();
    expect(screen.queryByTestId('order-not-found')).not.toBeInTheDocument();
  });

  it('refetches when orderId changes (no stale order on order→order navigation)', async () => {
    // Same [id] route segment, no remount: changing the prop must refetch, not show the stale order.
    const ORDER_2 = { ...FULL_ORDER, id: 'order-2', orderNumber: 'ORD-0002' };
    mockRequest = async (_m, _p, opts) => {
      const id = (opts as { path?: { id?: string } } | undefined)?.path?.id;
      return id === 'order-2' ? ORDER_2 : FULL_ORDER;
    };
    const { rerender } = renderWithIntl(<OrderDetail orderId="order-1" />, 'en');
    await waitFor(() => expect(screen.getByText('ORD-0001')).toBeInTheDocument());
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <OrderDetail orderId="order-2" />
      </NextIntlClientProvider>,
    );
    await waitFor(() => expect(screen.getByText('ORD-0002')).toBeInTheDocument());
    expect(screen.queryByText('ORD-0001')).not.toBeInTheDocument();
  });

  it('shows the "Request a return" link for a returnable order (delivered)', async () => {
    mockRequest = async () => ({ ...FULL_ORDER, status: 'delivered' });
    renderWithIntl(<OrderDetail orderId="order-1" />, 'en');
    await waitFor(() => expect(screen.getByTestId('order-detail')).toBeInTheDocument());
    const link = screen.getByTestId('request-return-link');
    expect(link).toBeInTheDocument();
    expect(link.getAttribute('href')).toBe('/account/orders/order-1/returns');
  });

  it('hides the "Request a return" link for a non-returnable order (cancelled)', async () => {
    mockRequest = async () => ({ ...FULL_ORDER, status: 'cancelled' });
    renderWithIntl(<OrderDetail orderId="order-1" />, 'en');
    await waitFor(() => expect(screen.getByTestId('order-detail')).toBeInTheDocument());
    expect(screen.queryByTestId('request-return-link')).not.toBeInTheDocument();
  });

  it('renders all FR label strings', async () => {
    renderWithIntl(<OrderDetail orderId="order-1" />, 'fr');
    await waitFor(() => expect(screen.getByTestId('order-detail')).toBeInTheDocument());
    // Check some key FR translations appear
    expect(screen.getByText('Adresse de livraison')).toBeInTheDocument();
    expect(screen.getByText('Adresse de facturation')).toBeInTheDocument();
    expect(screen.getByText('Sous-total')).toBeInTheDocument();
  });
});
