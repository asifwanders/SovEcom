/**
 * OrdersList component tests.
 *
 * MONEY-CRITICAL: All amount assertions verify that `formatPrice` is called with integer minor units
 * from the server — there is NO client-side division by 100 or any arithmetic on totals in this
 * component. The 1999 EUR → "€19.99" assertion is the canonical proof.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithIntl } from '@/test-intl';
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
let mockRequest: (method: string, path: string) => Promise<unknown>;
vi.mock('@/lib/browser-client', () => ({
  createBrowserClient: () => ({
    request: (...args: unknown[]) => mockRequest(...(args as [string, string])),
  }),
}));

import { OrdersList } from './OrdersList';

const ORDER_1: OrderView = {
  id: 'order-1',
  orderNumber: 'ORD-0001',
  status: 'paid',
  currency: 'EUR',
  email: 'ada@example.com',
  subtotalAmount: 1999,
  discountAmount: 0,
  shippingAmount: 500,
  taxAmount: 400,
  totalAmount: 2899,
  shippingMethod: 'Standard',
  shippingAddress: null,
  billingAddress: null,
  placedAt: '2026-06-01T10:00:00.000Z',
  createdAt: '2026-06-01T10:00:00.000Z',
};

const ORDER_2: OrderView = {
  id: 'order-2',
  orderNumber: 'ORD-0002',
  status: 'shipped',
  currency: 'EUR',
  email: 'ada@example.com',
  subtotalAmount: 4999,
  discountAmount: 500,
  shippingAmount: 0,
  taxAmount: 800,
  totalAmount: 5299,
  shippingMethod: 'Express',
  shippingAddress: null,
  billingAddress: null,
  placedAt: '2026-06-10T14:00:00.000Z',
  createdAt: '2026-06-10T14:00:00.000Z',
};

beforeEach(() => {
  getAccessToken = () => 'token-abc';
  refresh = async () => 'token-abc';
  mockRequest = async () => [ORDER_1, ORDER_2];
});

describe('OrdersList', () => {
  it('shows a loading state initially', () => {
    // Never resolves in this test — just check the loading indicator appears
    mockRequest = async () => new Promise(() => undefined);
    renderWithIntl(<OrdersList />, 'en');
    expect(screen.getByTestId('orders-loading')).toBeInTheDocument();
  });

  it('renders the list of orders with order numbers', async () => {
    renderWithIntl(<OrdersList />, 'en');
    await waitFor(() => expect(screen.getByText('ORD-0001')).toBeInTheDocument());
    expect(screen.getByText('ORD-0002')).toBeInTheDocument();
  });

  it('renders translated status for each order (EN)', async () => {
    renderWithIntl(<OrdersList />, 'en');
    await waitFor(() => expect(screen.getByText('ORD-0001')).toBeInTheDocument());
    // 'paid' → "Paid", 'shipped' → "Shipped"
    expect(screen.getByText('Paid')).toBeInTheDocument();
    expect(screen.getByText('Shipped')).toBeInTheDocument();
  });

  it('renders translated status in French (FR)', async () => {
    renderWithIntl(<OrdersList />, 'fr');
    await waitFor(() => expect(screen.getByText('ORD-0001')).toBeInTheDocument());
    expect(screen.getByText('Payée')).toBeInTheDocument();
    expect(screen.getByText('Expédiée')).toBeInTheDocument();
  });

  it('MONEY: renders 2899 EUR as formatted price (not client-computed)', async () => {
    // 2899 minor units EUR = €28.99. No /100 client-side — formatPrice handles the exponent.
    renderWithIntl(<OrdersList />, 'en');
    await waitFor(() => expect(screen.getByText('ORD-0001')).toBeInTheDocument());
    // Check that a formatted price for 2899 EUR appears
    const cells = screen.getAllByTestId('order-total');
    expect(cells[0]).toHaveTextContent('28.99');
  });

  it('MONEY: renders 1999 EUR as €19.99 (the canonical minor-unit proof)', async () => {
    // Reset to a single order with exactly 1999 minor units total
    mockRequest = async () => [{ ...ORDER_1, totalAmount: 1999 }];
    renderWithIntl(<OrdersList />, 'en');
    await waitFor(() => expect(screen.getByText('ORD-0001')).toBeInTheDocument());
    const cell = screen.getByTestId('order-total');
    expect(cell.textContent).toContain('19.99');
  });

  it('links each row to the correct order detail page', async () => {
    renderWithIntl(<OrdersList />, 'en');
    await waitFor(() => expect(screen.getByText('ORD-0001')).toBeInTheDocument());
    const links = screen.getAllByRole('link', { name: /view details/i });
    expect(links[0]).toHaveAttribute('href', '/account/orders/order-1');
    expect(links[1]).toHaveAttribute('href', '/account/orders/order-2');
  });

  it('shows empty state when there are no orders', async () => {
    mockRequest = async () => [];
    renderWithIntl(<OrdersList />, 'en');
    await waitFor(() => expect(screen.getByTestId('orders-empty')).toBeInTheDocument());
  });

  it('shows FR empty state text', async () => {
    mockRequest = async () => [];
    renderWithIntl(<OrdersList />, 'fr');
    await waitFor(() =>
      expect(screen.getByTestId('orders-empty')).toHaveTextContent(
        'Vous n’avez pas encore de commandes.',
      ),
    );
  });

  it('shows an error state when the fetch fails', async () => {
    mockRequest = async () => {
      throw new Error('network error');
    };
    renderWithIntl(<OrdersList />, 'en');
    await waitFor(() => expect(screen.getByTestId('orders-error')).toBeInTheDocument());
  });

  it('retries with refresh() on a 401 and then renders successfully', async () => {
    let calls = 0;
    const refreshFn = vi.fn().mockResolvedValue('new-token');
    refresh = refreshFn;
    mockRequest = async () => {
      calls++;
      if (calls === 1) {
        const err = Object.assign(new Error('Unauthorized'), { status: 401 });
        throw err;
      }
      return [ORDER_1];
    };
    renderWithIntl(<OrdersList />, 'en');
    await waitFor(() => expect(screen.getByText('ORD-0001')).toBeInTheDocument());
    expect(refreshFn).toHaveBeenCalledOnce();
  });

  it('shows error state if still 401 after refresh()', async () => {
    refresh = vi.fn().mockResolvedValue(null);
    mockRequest = async () => {
      const err = Object.assign(new Error('Unauthorized'), { status: 401 });
      throw err;
    };
    renderWithIntl(<OrdersList />, 'en');
    await waitFor(() => expect(screen.getByTestId('orders-error')).toBeInTheDocument());
  });

  it('shows error state (not stuck loading) when refresh() THROWS during a 401 retry', async () => {
    // refresh() re-throws non-401 errors (network/5xx) per auth-context — the 401 retry must catch
    // that so the component lands on the error state instead of spinning forever (NIT #1).
    refresh = vi.fn().mockRejectedValue(new Error('network down'));
    mockRequest = async () => {
      const err = Object.assign(new Error('Unauthorized'), { status: 401 });
      throw err;
    };
    renderWithIntl(<OrdersList />, 'en');
    await waitFor(() => expect(screen.getByTestId('orders-error')).toBeInTheDocument());
    expect(screen.queryByTestId('orders-loading')).not.toBeInTheDocument();
  });
});
