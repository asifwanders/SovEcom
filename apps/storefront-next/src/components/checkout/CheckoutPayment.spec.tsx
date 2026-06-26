/**
 * CheckoutPayment contract: the money-critical step. Stripe.js is fully MOCKED (no real key,
 * no network). We assert the REAL backend order-creation sequence + the paranoid error handling:
 *   - flow: POST /checkout (creates order, captures one-time guestAccessToken) → POST /payment-intent
 *     (reuses the SAME order, returns clientSecret) → <Elements clientSecret> mounts <PaymentElement> →
 *     confirmPayment success → route to /checkout/success.
 *   - declined card → clear retry-able error, NO success route (order not "completed" client-side).
 *   - network failure mid-confirm → handled, retry-able.
 *   - double-submit guarded (button disabled + guard while confirming).
 *   - browser-back / re-entry: payment-intent says `paid` → idempotent → route straight to success, no
 *     second order, no re-charge.
 *   - PLACEHOLDER address: checkout/payment-intent NOT called when the cart carries the "—" placeholder.
 *   - missing publishable key → config error, no Stripe load, no crash.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, act, fireEvent } from '@testing-library/react';
import { renderWithIntl } from '@/test-intl';

// ── Router mock ────────────────────────────────────────────────────────────────────────────────
const replace = vi.fn();
const push = vi.fn();
vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ replace, push }),
  Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

// ── Stripe.js mocks ──────────────────────────────────────────────────────────────────────────────
let stripeConfigured = true;
const getStripeMock = vi.fn();
vi.mock('@/lib/stripe', () => ({
  getStripe: () => getStripeMock(),
  isStripeConfigured: () => stripeConfigured,
}));

const confirmPayment = vi.fn();
const useStripeMock = vi.fn();
const useElementsMock = vi.fn();
// <Elements> just renders children once a clientSecret/stripe is provided; <PaymentElement> is a marker.
vi.mock('@stripe/react-stripe-js', () => ({
  Elements: ({
    children,
    options,
  }: {
    children: React.ReactNode;
    options?: { clientSecret?: string; locale?: string };
  }) => (
    <div
      data-testid="stripe-elements"
      data-client-secret={options?.clientSecret ?? ''}
      data-locale={options?.locale ?? ''}
    >
      {children}
    </div>
  ),
  PaymentElement: () => <div data-testid="payment-element" />,
  useStripe: () => useStripeMock(),
  useElements: () => useElementsMock(),
}));

// ── Cart + auth context mocks ──────────────────────────────────────────────────────────────────
const REAL_ADDRESS = {
  name: 'Jane',
  line1: '1 Rue',
  city: 'Paris',
  postalCode: '75001',
  country: 'FR',
};
const PLACEHOLDER_ADDRESS = {
  name: '—',
  line1: '—',
  city: '—',
  postalCode: '75001',
  country: 'FR',
};

let cart: Record<string, unknown> | null;
const refresh = vi.fn<() => Promise<void>>();
vi.mock('@/lib/cart-context', () => ({
  useCart: () => ({ cart, refresh }),
}));

let isAuthenticated = false;
vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ isAuthenticated, getAccessToken: () => (isAuthenticated ? 'jwt' : null) }),
}));

// ── browser-client mock (the credentialed data layer the step calls for checkout/payment-intent) ──
const request = vi.fn();
vi.mock('@/lib/browser-client', () => ({
  createBrowserClient: () => ({ request }),
}));

// ── order-lookup: spy the writers, keep the real cartId-keyed recovery (real sessionStorage) ───────
const storeGuestOrderToken = vi.fn();
vi.mock('@/lib/order-lookup', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    // Spy the token writer; still drive the real cartId-keyed stash so the F1 recovery round-trips.
    storeGuestOrderToken: (...a: unknown[]) => storeGuestOrderToken(...a),
    storeGuestCheckout: (...a: unknown[]) => {
      storeGuestCheckoutSpy(...a);
      return (actual.storeGuestCheckout as (...x: unknown[]) => void)(...a);
    },
  };
});
const storeGuestCheckoutSpy = vi.fn();

import { CheckoutPayment } from './CheckoutPayment';
import { storeGuestCheckout as realStoreGuestCheckout } from '@/lib/order-lookup';

function cartWith(address: unknown): Record<string, unknown> {
  return {
    id: 'cart_1',
    items: [{ id: 'li1', variantId: 'v1', quantity: 1, unitPriceAmount: 1999, currency: 'EUR' }],
    shippingAddress: address,
    shippingRateId: 'rate_1',
    guestEmail: 'shopper@example.com',
    totals: {
      subtotal: 1999,
      shipping: 0,
      discountTotal: 0,
      taxTotal: 0,
      grandTotal: 1999,
      currency: 'EUR',
      reverseCharge: false,
    },
  };
}

// A checkout response (order created + the one-time guest token) and a payment-intent response.
const CHECKOUT_OK = {
  id: 'order_1',
  orderNumber: 'SOV-1001',
  status: 'pending_payment',
  currency: 'EUR',
  totalAmount: 1999,
  guestAccessToken: 'guest-tok-xyz',
};
const PI_REQUIRES = {
  orderId: 'order_1',
  status: 'requires_payment',
  clientSecret: 'pi_secret_123',
  amount: 1999,
  currency: 'EUR',
};

beforeEach(() => {
  replace.mockReset();
  push.mockReset();
  stripeConfigured = true;
  getStripeMock.mockReset().mockReturnValue(Promise.resolve({ id: 'stripe' }));
  confirmPayment.mockReset();
  useStripeMock.mockReset().mockReturnValue({ confirmPayment });
  useElementsMock.mockReset().mockReturnValue({});
  request.mockReset();
  storeGuestOrderToken.mockReset();
  storeGuestCheckoutSpy.mockReset();
  window.sessionStorage.clear();
  refresh.mockReset().mockResolvedValue();
  isAuthenticated = false;
  cart = cartWith(REAL_ADDRESS);
});

/** Route POST /checkout and POST /payment-intent to canned responses. */
function wireHappyServer() {
  request.mockImplementation((method: string, path: string) => {
    if (path === '/store/v1/carts/{cartId}/checkout') return Promise.resolve(CHECKOUT_OK);
    if (path === '/store/v1/carts/{cartId}/payment-intent') return Promise.resolve(PI_REQUIRES);
    return Promise.reject(new Error(`unexpected ${method} ${path}`));
  });
}

describe('CheckoutPayment — order-creation sequence', () => {
  it('creates the order (checkout), captures the guest token, then mounts PaymentElement with the clientSecret', async () => {
    wireHappyServer();
    await act(async () => {
      renderWithIntl(<CheckoutPayment />, 'en');
    });

    // Order created via /checkout FIRST; payment-intent reuses the same order.
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        'post',
        '/store/v1/carts/{cartId}/checkout',
        expect.anything(),
      ),
    );
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        'post',
        '/store/v1/carts/{cartId}/payment-intent',
        expect.anything(),
      ),
    );

    // One-time guest token stashed for the confirmation page (never logged), AND a cartId-keyed
    // reference (order number + token) so a later 409-swallow re-entry can recover the REAL number (F1).
    expect(storeGuestOrderToken).toHaveBeenCalledWith('SOV-1001', 'guest-tok-xyz');
    expect(storeGuestCheckoutSpy).toHaveBeenCalledWith('cart_1', 'SOV-1001', 'guest-tok-xyz');

    // Elements mounts with the server clientSecret; the PaymentElement is rendered.
    const elements = await screen.findByTestId('stripe-elements');
    expect(elements.getAttribute('data-client-secret')).toBe('pi_secret_123');
    // M1: the active next-intl locale is threaded into Elements so the Payment Element + error copy render
    // in the session language (here `en`), not the browser default.
    expect(elements.getAttribute('data-locale')).toBe('en');
    expect(await screen.findByTestId('payment-element')).toBeInTheDocument();
  });

  it('M1: threads the FRENCH session locale into <Elements> so Stripe renders in French', async () => {
    wireHappyServer();
    await act(async () => {
      renderWithIntl(<CheckoutPayment />, 'fr');
    });
    const elements = await screen.findByTestId('stripe-elements');
    expect(elements.getAttribute('data-locale')).toBe('fr');
  });

  it('confirm success → routes to the success page', async () => {
    wireHappyServer();
    confirmPayment.mockResolvedValue({ paymentIntent: { status: 'succeeded' } });
    await act(async () => {
      renderWithIntl(<CheckoutPayment />, 'en');
    });
    await screen.findByTestId('payment-element');
    await act(async () => {
      fireEvent.click(screen.getByTestId('pay-button'));
    });
    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith(expect.stringContaining('/checkout/success')),
    );
    expect(String(replace.mock.calls[0]?.[0])).toContain('SOV-1001');
  });
});

describe('CheckoutPayment — paranoid error handling', () => {
  it('declined card → clear retry-able error, does NOT route to success', async () => {
    wireHappyServer();
    confirmPayment.mockResolvedValue({
      error: { type: 'card_error', message: 'Your card was declined.' },
    });
    await act(async () => {
      renderWithIntl(<CheckoutPayment />, 'en');
    });
    await screen.findByTestId('payment-element');
    await act(async () => {
      fireEvent.click(screen.getByTestId('pay-button'));
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(/declined/i);
    expect(replace).not.toHaveBeenCalled();
    // Still retry-able: the pay button is re-enabled after the failure.
    expect(screen.getByTestId('pay-button')).not.toBeDisabled();
  });

  it('network failure mid-confirm → handled, retry-able, no success route', async () => {
    wireHappyServer();
    confirmPayment.mockRejectedValue(new Error('network down'));
    await act(async () => {
      renderWithIntl(<CheckoutPayment />, 'en');
    });
    await screen.findByTestId('payment-element');
    await act(async () => {
      fireEvent.click(screen.getByTestId('pay-button'));
    });
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByTestId('pay-button')).not.toBeDisabled();
  });

  it('double-submit guarded: a second click while confirming does not call confirmPayment twice', async () => {
    wireHappyServer();
    let resolveConfirm: (v: unknown) => void = () => {};
    confirmPayment.mockReturnValue(
      new Promise((res) => {
        resolveConfirm = res;
      }),
    );
    await act(async () => {
      renderWithIntl(<CheckoutPayment />, 'en');
    });
    await screen.findByTestId('payment-element');
    await act(async () => {
      fireEvent.click(screen.getByTestId('pay-button'));
    });
    // Button disabled while in flight; a second click is a no-op.
    expect(screen.getByTestId('pay-button')).toBeDisabled();
    await act(async () => {
      fireEvent.click(screen.getByTestId('pay-button'));
    });
    await act(async () => {
      resolveConfirm({ paymentIntent: { status: 'succeeded' } });
    });
    expect(confirmPayment).toHaveBeenCalledTimes(1);
  });

  it('browser-back / re-entry: payment-intent already `paid` → routes straight to success, no second charge', async () => {
    request.mockImplementation((_m: string, path: string) => {
      if (path === '/store/v1/carts/{cartId}/checkout') return Promise.resolve(CHECKOUT_OK);
      if (path === '/store/v1/carts/{cartId}/payment-intent')
        return Promise.resolve({
          orderId: 'order_1',
          status: 'paid',
          clientSecret: null,
          amount: 1999,
          currency: 'EUR',
        });
      return Promise.reject(new Error('unexpected'));
    });
    await act(async () => {
      renderWithIntl(<CheckoutPayment />, 'en');
    });
    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith(expect.stringContaining('/checkout/success')),
    );
    // It never even mounted a PaymentElement (nothing to confirm — no re-charge path).
    expect(screen.queryByTestId('payment-element')).toBeNull();
  });

  it('F1 — guest 409-swallow recovers the REAL order NUMBER + token and routes a by-number success (never a UUID)', async () => {
    // A prior attempt already created the order; the cartId-keyed stash from that attempt survives.
    realStoreGuestCheckout('cart_1', 'SOV-1001', 'guest-tok-xyz');
    const conflict = Object.assign(new Error('already ordered'), { status: 409 });
    request.mockImplementation((_m: string, path: string) => {
      if (path === '/store/v1/carts/{cartId}/checkout') return Promise.reject(conflict);
      if (path === '/store/v1/carts/{cartId}/payment-intent')
        // The PI response carries ONLY the order UUID, never the number.
        return Promise.resolve({
          orderId: 'order_1',
          status: 'paid',
          clientSecret: null,
          amount: 1999,
          currency: 'EUR',
        });
      return Promise.reject(new Error('unexpected'));
    });
    await act(async () => {
      renderWithIntl(<CheckoutPayment />, 'en');
    });
    await waitFor(() => expect(replace).toHaveBeenCalled());
    const url = String(replace.mock.calls[0]?.[0]);
    // Routed with the REAL order number in the `order=` slot…
    expect(url).toContain('order=SOV-1001');
    // …and NEVER the order UUID as the order number (the F1 lockout would do `order=order_1`).
    expect(url).not.toContain('order=order_1');
  });

  it('F1 — guest 409-swallow with the stash GONE falls back honestly (routes a number-less success, no UUID-as-number)', async () => {
    // No prior stash survives (cleared storage / different tab).
    const conflict = Object.assign(new Error('already ordered'), { status: 409 });
    request.mockImplementation((_m: string, path: string) => {
      if (path === '/store/v1/carts/{cartId}/checkout') return Promise.reject(conflict);
      if (path === '/store/v1/carts/{cartId}/payment-intent')
        return Promise.resolve({
          orderId: 'order_1',
          status: 'paid',
          clientSecret: null,
          amount: 1999,
          currency: 'EUR',
        });
      return Promise.reject(new Error('unexpected'));
    });
    await act(async () => {
      renderWithIntl(<CheckoutPayment />, 'en');
    });
    await waitFor(() => expect(replace).toHaveBeenCalled());
    const url = String(replace.mock.calls[0]?.[0]);
    // It still routes to the success page, but NEVER puts the UUID in the order-number slot — the
    // success page then shows the honest "check your email" fallback (the accepted floor).
    expect(url).toContain('/checkout/success');
    expect(url).not.toContain('order=order_1');
  });
});

describe('CheckoutPayment — placeholder-address guard (Chunk-E BINDING / Chunk-F verify)', () => {
  it('does NOT initiate checkout OR payment-intent when the cart still carries the "—" placeholder address', async () => {
    wireHappyServer();
    cart = cartWith(PLACEHOLDER_ADDRESS);
    await act(async () => {
      renderWithIntl(<CheckoutPayment />, 'en');
    });
    // A guard error is shown and NO order/payment-intent call is made (no order can be created).
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(request).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });
});

describe('CheckoutPayment — missing publishable key', () => {
  it('shows a configuration error and does NOT load Stripe or create an order', async () => {
    stripeConfigured = false;
    getStripeMock.mockReturnValue(null);
    wireHappyServer();
    await act(async () => {
      renderWithIntl(<CheckoutPayment />, 'en');
    });
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(request).not.toHaveBeenCalled();
    expect(screen.queryByTestId('payment-element')).toBeNull();
  });

  it('localizes the pay button label in French', async () => {
    wireHappyServer();
    await act(async () => {
      renderWithIntl(<CheckoutPayment />, 'fr');
    });
    await screen.findByTestId('payment-element');
    expect(screen.getByTestId('pay-button').textContent ?? '').toMatch(/payer/i);
  });
});
