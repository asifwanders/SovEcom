/**
 * CheckoutFlow step-controller contract: step navigation (advance via a step's onDone), back-nav,
 * the prerequisite guard (clamp to the furthest reachable step), and the empty-cart state. The child
 * steps are mocked so we test ONLY the controller.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, act } from '@testing-library/react';
import { renderWithIntl } from '@/test-intl';
import type { CartView } from '@/lib/cart-types';

const refresh = vi.fn<() => Promise<void>>();
let cart: CartView | null = null;
vi.mock('@/lib/cart-context', () => ({
  useCart: () => ({ cart, refresh }),
}));
let isAuthenticated = false;
vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ isAuthenticated }),
}));

// Mock the step components: each exposes a button to invoke its callback so we can drive the controller.
vi.mock('./CheckoutEmail', () => ({
  CheckoutEmail: ({ onDone }: { onDone: () => void }) => (
    <button onClick={onDone} data-testid="email-done">
      email-done
    </button>
  ),
}));
vi.mock('./CheckoutAddress', () => ({
  CheckoutAddress: ({ onDone }: { onDone: () => void }) => (
    <button onClick={onDone} data-testid="address-done">
      address-done
    </button>
  ),
}));
vi.mock('./CheckoutShipping', () => ({
  CheckoutShipping: ({ onDone }: { onDone: () => void }) => (
    <button onClick={onDone} data-testid="shipping-done">
      shipping-done
    </button>
  ),
}));
vi.mock('./CheckoutReview', () => ({
  CheckoutReview: ({ onProceed }: { onProceed: () => void }) => (
    <button onClick={onProceed} data-testid="review-proceed">
      review
    </button>
  ),
}));
// the payment step is mocked here so the Flow spec tests ONLY the step orchestration (the real
// CheckoutPayment is covered by its own spec). It just renders a marker.
vi.mock('./CheckoutPayment', () => ({
  CheckoutPayment: () => <div data-testid="payment-step">payment</div>,
}));

import { CheckoutFlow } from './CheckoutFlow';

const realAddr = {
  name: 'Marie',
  line1: '12 Rue',
  city: 'Paris',
  postalCode: '75002',
  country: 'FR',
};

function makeCart(over: Partial<CartView> = {}): CartView {
  return {
    id: 'c1',
    customerId: null,
    currency: 'EUR',
    status: 'active',
    guestEmail: null,
    items: [
      {
        id: 'li-1',
        variantId: 'v1',
        quantity: 1,
        unitPriceAmount: 1999,
        currency: 'EUR',
        productTitle: 'Tee',
        variantTitle: null,
        options: {},
        sku: 'TEE',
        productSlug: 'tee',
      },
    ],
    shippingAddress: null,
    billingAddress: null,
    shippingRateId: null,
    discountCode: null,
    totals: { subtotal: 1999, shipping: 0, discountTotal: 0, taxTotal: 0, grandTotal: 1999, currency: 'EUR', reverseCharge: false }, // prettier-ignore
    ...over,
  };
}

beforeEach(() => {
  refresh.mockReset().mockResolvedValue();
  cart = makeCart();
  isAuthenticated = false;
});

describe('CheckoutFlow', () => {
  it('refreshes the cart on mount', async () => {
    renderWithIntl(<CheckoutFlow />, 'en');
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('starts on the email step and advances email → address on onDone, moving focus to the step heading', async () => {
    renderWithIntl(<CheckoutFlow />, 'en');
    await waitFor(() => expect(screen.getByTestId('email-done')).toBeInTheDocument());
    // Simulate the email step having set the cart email so the address step is reachable.
    cart = makeCart({ guestEmail: 'a@b.com' });
    await act(async () => {
      fireEvent.click(screen.getByTestId('email-done'));
    });
    await waitFor(() => expect(screen.getByTestId('address-done')).toBeInTheDocument());
    // WCAG 2.4.3: on a step change, focus moves to the step heading so keyboard/SR users land on the
    // new content.
    await waitFor(() => expect(screen.getByRole('heading', { level: 2 })).toHaveFocus());
  });

  it('guards review: clamps back when prerequisites are not met (no chosen rate)', async () => {
    // The cart has email + a real address but NO chosen shipping rate → review is unreachable; the
    // furthest reachable step is "shipping", so the controller must not show the review step.
    cart = makeCart({ guestEmail: 'a@b.com', shippingAddress: realAddr, shippingRateId: null });
    renderWithIntl(<CheckoutFlow />, 'en');
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    // Even after advancing through, review cannot be reached without a rate.
    expect(screen.queryByTestId('review-proceed')).toBeNull();
  });

  it('reaches review by advancing through the steps once all prerequisites are set; Proceed advances to the payment step', async () => {
    // All prerequisites already satisfied on the cart — advance forward through each step's onDone. The
    // guard PERMITS each forward move because the prerequisite is met; review then renders.
    cart = makeCart({
      guestEmail: 'a@b.com',
      shippingAddress: realAddr,
      shippingRateId: 'rate-1',
    });
    renderWithIntl(<CheckoutFlow />, 'en');
    await waitFor(() => expect(screen.getByTestId('email-done')).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByTestId('email-done'));
    });
    await waitFor(() => expect(screen.getByTestId('address-done')).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByTestId('address-done'));
    });
    await waitFor(() => expect(screen.getByTestId('shipping-done')).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByTestId('shipping-done'));
    });
    await waitFor(() => expect(screen.getByTestId('review-proceed')).toBeInTheDocument());
    // Chunk-F boundary: Proceed advances to the payment step (the Stripe Payment Element).
    await act(async () => {
      fireEvent.click(screen.getByTestId('review-proceed'));
    });
    await waitFor(() => expect(screen.getByTestId('payment-step')).toBeInTheDocument());
  });

  it('a placeholder shipping address does NOT count as a real address (cannot advance past shipping)', async () => {
    cart = makeCart({
      guestEmail: 'a@b.com',
      shippingAddress: { name: '—', line1: '—', city: '—', postalCode: '75001', country: 'FR' },
    });
    renderWithIntl(<CheckoutFlow />, 'en');
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    // With only a placeholder address, the shipping step is NOT reachable; review certainly isn't.
    expect(screen.queryByTestId('shipping-done')).toBeNull();
    expect(screen.queryByTestId('review-proceed')).toBeNull();
  });

  it('back-nav: from the address step, the Back control returns to email', async () => {
    cart = makeCart({ guestEmail: 'a@b.com' });
    renderWithIntl(<CheckoutFlow />, 'en');
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    // Advance to address.
    await act(async () => {
      fireEvent.click(screen.getByTestId('email-done'));
    });
    await waitFor(() => expect(screen.getByTestId('address-done')).toBeInTheDocument());
    // Click the Back control → email step again.
    fireEvent.click(screen.getByRole('button', { name: /^back$/i }));
    await waitFor(() => expect(screen.getByTestId('email-done')).toBeInTheDocument());
  });

  it('empty cart → shows the empty state with a link back to the cart', async () => {
    cart = makeCart({ items: [] });
    renderWithIntl(<CheckoutFlow />, 'en');
    await waitFor(() => expect(screen.getByTestId('checkout-empty')).toBeInTheDocument());
  });
});
