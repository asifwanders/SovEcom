/**
 * CheckoutSuccess / order confirmation contract.
 *
 * Reads the order for display: logged-in via JWT (`GET /store/v1/orders/{id}`), guest via the stashed
 * one-time token in the `X-Order-Token` header (`GET /store/v1/orders/by-number/{orderNumber}`). Also
 * handles the post-redirect return (a redirect-based method returns to `return_url` with
 * `payment_intent_client_secret` in the query → retrieve the PaymentIntent status and reflect it).
 * Money renders via `formatPrice` (integer minor units). All Stripe + data-layer access is MOCKED.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, act } from '@testing-library/react';
import { renderWithIntl } from '@/test-intl';

// ── Router / search-params ───────────────────────────────────────────────────────────────────────
let searchParams = new URLSearchParams('order=SOV-1001');
vi.mock('next/navigation', () => ({
  useSearchParams: () => searchParams,
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

// ── auth context ─────────────────────────────────────────────────────────────────────────────────
let isAuthenticated = false;
vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({
    isAuthenticated,
    isLoading: false,
    getAccessToken: () => (isAuthenticated ? 'jwt' : null),
  }),
}));

// ── browser-client ─────────────────────────────────────────────────────────────────────────────
const request = vi.fn();
vi.mock('@/lib/browser-client', () => ({
  createBrowserClient: () => ({ request }),
}));

// ── Stripe (for the post-redirect PaymentIntent status retrieve) ─────────────────────────────────
const retrievePaymentIntent = vi.fn();
vi.mock('@/lib/stripe', () => ({
  getStripe: () => Promise.resolve({ retrievePaymentIntent }),
  isStripeConfigured: () => true,
}));

// ── order-token storage (guest) ──────────────────────────────────────────────────────────────────
let storedToken: string | null = 'guest-tok-xyz';
vi.mock('@/lib/order-lookup', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    readGuestOrderToken: () => storedToken,
  };
});

import { CheckoutSuccess } from './CheckoutSuccess';

const ORDER = {
  id: 'order_1',
  orderNumber: 'SOV-1001',
  status: 'pending_payment',
  currency: 'EUR',
  email: 'shopper@example.com',
  subtotalAmount: 1999,
  discountAmount: 0,
  shippingAmount: 0,
  taxAmount: 0,
  totalAmount: 1999,
  shippingMethod: 'Standard',
  shippingAddress: null,
  billingAddress: null,
  placedAt: null,
  createdAt: '2026-06-18T00:00:00Z',
  items: [
    {
      id: 'i1',
      productTitle: 'Widget',
      variantTitle: 'Blue',
      sku: 'W-1',
      quantity: 1,
      unitPriceAmount: 1999,
      lineTotalAmount: 1999,
    },
  ],
};

// The same order once the webhook has flipped it to `paid` (the source of truth for the affirmative copy).
const PAID_ORDER = { ...ORDER, status: 'paid' };

beforeEach(() => {
  request.mockReset();
  retrievePaymentIntent.mockReset();
  searchParams = new URLSearchParams('order=SOV-1001');
  isAuthenticated = false;
  storedToken = 'guest-tok-xyz';
});

describe('CheckoutSuccess — order read', () => {
  it('guest: reads the order via the X-Order-Token header (by order number) and renders number + total', async () => {
    request.mockResolvedValue(ORDER);
    await act(async () => {
      renderWithIntl(<CheckoutSuccess />, 'en');
    });
    await waitFor(() => expect(request).toHaveBeenCalled());
    const [method, path, opts] = request.mock.calls[0] ?? [];
    expect(method).toBe('get');
    expect(path).toBe('/store/v1/orders/by-number/{orderNumber}');
    expect(opts.path.orderNumber).toBe('SOV-1001');
    expect(opts.headers['x-order-token']).toBe('guest-tok-xyz');

    expect(await screen.findByText(/SOV-1001/)).toBeInTheDocument();
    // Total rendered via formatPrice (minor units → €19.99), never /100 by hand.
    expect(screen.getByTestId('order-total').textContent ?? '').toMatch(/19[.,]99/);
  });

  it('logged-in: reads the order via JWT (GET /orders/{id}), not the guest endpoint', async () => {
    isAuthenticated = true;
    // The query carries an order id for an authenticated read.
    searchParams = new URLSearchParams('order=SOV-1001&id=order_1');
    request.mockResolvedValue(ORDER);
    await act(async () => {
      renderWithIntl(<CheckoutSuccess />, 'en');
    });
    await waitFor(() => expect(request).toHaveBeenCalled());
    const [method, path, opts] = request.mock.calls[0] ?? [];
    expect(method).toBe('get');
    expect(path).toBe('/store/v1/orders/{id}');
    expect(opts.path.id).toBe('order_1');
    expect(await screen.findByText(/SOV-1001/)).toBeInTheDocument();
  });

  it('renders the emailed-receipt note (no self-referential / 404 link)', async () => {
    request.mockResolvedValue(ORDER);
    await act(async () => {
      renderWithIntl(<CheckoutSuccess />, 'en');
    });
    // The honest "we emailed your receipt" note — NOT a self-referential receipt link that would
    // dead-end on the cleared token, and NOT the 3.8b /account/orders/{id} route that 404s today.
    expect(await screen.findByTestId('order-receipt-note')).toBeInTheDocument();
    expect(screen.queryByTestId('order-receipt-link')).toBeNull();
  });

  it('authenticated: renders a link to /account/orders/{id}', async () => {
    // authenticated users on the success screen get a real "View your receipt" link pointing to
    // /account/orders/{id}.
    isAuthenticated = true;
    searchParams = new URLSearchParams('order=SOV-1001&id=order_1');
    request.mockResolvedValue(PAID_ORDER);
    const { container } = (await act(async () => {
      return renderWithIntl(<CheckoutSuccess />, 'en');
    }))!;
    await screen.findByTestId('checkout-success');
    expect(container.querySelector('a[href*="/account/orders/order_1"]')).not.toBeNull();
    expect(screen.getByTestId('order-detail-link')).toBeInTheDocument();
  });

  it('lost-token guest (no JWT, no stored token) → friendly fallback, no crash', async () => {
    storedToken = null;
    await act(async () => {
      renderWithIntl(<CheckoutSuccess />, 'en');
    });
    expect(await screen.findByTestId('order-lookup-fallback')).toBeInTheDocument();
    expect(request).not.toHaveBeenCalled();
  });
});

describe('CheckoutSuccess — post-redirect return', () => {
  it('reads payment_intent_client_secret, retrieves the PI status, and shows success ONCE the order is paid', async () => {
    searchParams = new URLSearchParams('order=SOV-1001&payment_intent_client_secret=pi_abc_secret');
    retrievePaymentIntent.mockResolvedValue({ paymentIntent: { status: 'succeeded' } });
    request.mockResolvedValue(PAID_ORDER); // webhook has flipped the order to paid
    await act(async () => {
      renderWithIntl(<CheckoutSuccess />, 'en');
    });
    await waitFor(() => expect(retrievePaymentIntent).toHaveBeenCalledWith('pi_abc_secret'));
    expect(await screen.findByTestId('payment-succeeded')).toBeInTheDocument();
  });

  it('post-redirect FAILED PaymentIntent → shows a failure/retry state, not a success', async () => {
    searchParams = new URLSearchParams('order=SOV-1001&payment_intent_client_secret=pi_abc_secret');
    retrievePaymentIntent.mockResolvedValue({
      paymentIntent: { status: 'requires_payment_method' },
    });
    await act(async () => {
      renderWithIntl(<CheckoutSuccess />, 'en');
    });
    await waitFor(() => expect(retrievePaymentIntent).toHaveBeenCalled());
    expect(await screen.findByTestId('payment-failed')).toBeInTheDocument();
  });
});

describe('CheckoutSuccess — never claim "paid" before the webhook confirms', () => {
  it('inline success while the order is still pending_payment → does NOT claim paid; shows confirming', async () => {
    // Inline card confirm reported succeeded, but the webhook hasn't flipped the order yet.
    searchParams = new URLSearchParams('order=SOV-1001&pi_status=succeeded');
    request.mockResolvedValue(ORDER); // status: pending_payment
    await act(async () => {
      renderWithIntl(<CheckoutSuccess />, 'en');
    });
    await screen.findByTestId('checkout-success');
    // The affirmative "Payment succeeded" marker is ABSENT until the order itself is paid.
    expect(screen.queryByTestId('payment-succeeded')).toBeNull();
    // A neutral "we're confirming your payment" state is shown instead.
    expect(screen.getByTestId('payment-processing')).toBeInTheDocument();
  });

  it('inline pi_status=processing → treated as processing, not succeeded', async () => {
    searchParams = new URLSearchParams('order=SOV-1001&pi_status=processing');
    request.mockResolvedValue(ORDER);
    await act(async () => {
      renderWithIntl(<CheckoutSuccess />, 'en');
    });
    await screen.findByTestId('checkout-success');
    expect(screen.queryByTestId('payment-succeeded')).toBeNull();
    expect(screen.getByTestId('payment-processing')).toBeInTheDocument();
  });

  it('order paid (webhook flipped) → shows the affirmative paid copy', async () => {
    searchParams = new URLSearchParams('order=SOV-1001&pi_status=succeeded');
    request.mockResolvedValue(PAID_ORDER);
    await act(async () => {
      renderWithIntl(<CheckoutSuccess />, 'en');
    });
    expect(await screen.findByTestId('payment-succeeded')).toBeInTheDocument();
    expect(screen.queryByTestId('payment-processing')).toBeNull();
  });
});
