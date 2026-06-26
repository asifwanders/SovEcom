/**
 * CheckoutReview contract: renders the server totals + addresses + chosen method + line-item
 * snapshot names, and a "Proceed to payment" CTA. Money figures come from `cart.totals` — no client
 * math.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithIntl } from '@/test-intl';
import type { CartView, ShippingRateView } from '@/lib/cart-types';

let cart: CartView | null = null;
let shippingRates: ShippingRateView[] | null = null;
vi.mock('@/lib/cart-context', () => ({
  useCart: () => ({ cart, shippingRates, refresh: vi.fn() }),
}));
// CheckoutVat renders nothing for a guest — stub auth as a guest so Review's embedded VAT block is inert.
vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ customer: null, isAuthenticated: false, updateVatNumber: vi.fn() }),
}));

import { CheckoutReview } from './CheckoutReview';

function makeCart(over: Partial<CartView> = {}): CartView {
  return {
    id: 'c1',
    customerId: null,
    currency: 'EUR',
    status: 'active',
    guestEmail: 'a@b.com',
    items: [
      {
        id: 'li-1',
        variantId: 'v1',
        quantity: 2,
        unitPriceAmount: 1999,
        currency: 'EUR',
        productTitle: 'Blue Tee',
        variantTitle: 'Medium',
        options: { Size: 'M' },
        sku: 'TEE-M',
        productSlug: 'blue-tee',
      },
    ],
    shippingAddress: {
      name: 'Marie Curie',
      line1: '12 Rue de la Paix',
      city: 'Paris',
      postalCode: '75002',
      country: 'FR',
    },
    billingAddress: null,
    shippingRateId: 'rate-1',
    discountCode: null,
    totals: { subtotal: 3998, shipping: 499, discountTotal: 0, taxTotal: 800, grandTotal: 5297, currency: 'EUR', reverseCharge: false }, // prettier-ignore
    ...over,
  };
}

beforeEach(() => {
  cart = makeCart();
  shippingRates = [{ id: 'rate-1', name: 'Standard', type: 'flat', amount: 499, currency: 'EUR' }];
});

describe('CheckoutReview', () => {
  it('renders the line-item snapshot name (not the variant UUID) and the server grand total', () => {
    renderWithIntl(<CheckoutReview onProceed={vi.fn()} locale="en" />, 'en');
    expect(screen.getByTestId('review-line-name')).toHaveTextContent('Blue Tee');
    // Server grandTotal 5297 minor → €52.97 (formatPrice; no client math).
    expect(screen.getByTestId('grand-total')).toHaveTextContent(/52\.97/);
  });

  it('renders the chosen shipping address and method', () => {
    renderWithIntl(<CheckoutReview onProceed={vi.fn()} locale="en" />, 'en');
    // Billing defaults to shipping when no separate billing is set, so the name appears in BOTH blocks.
    expect(screen.getAllByText(/Marie Curie/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/12 Rue de la Paix/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/shipping to/i)).toBeInTheDocument();
    expect(screen.getByTestId('review-method')).toHaveTextContent(/Standard/);
  });

  it('"Proceed to payment" invokes onProceed (the Chunk-F boundary)', () => {
    const onProceed = vi.fn();
    renderWithIntl(<CheckoutReview onProceed={onProceed} locale="en" />, 'en');
    fireEvent.click(screen.getByTestId('proceed-to-payment'));
    expect(onProceed).toHaveBeenCalled();
  });

  it('localizes the proceed CTA in French', () => {
    renderWithIntl(<CheckoutReview onProceed={vi.fn()} locale="fr" />, 'fr');
    expect(screen.getByText(/procéder au paiement/i)).toBeInTheDocument();
  });
});
