/**
 * CheckoutShipping contract: lists server rates for the cart's real destination, selects one
 * (totals adopt server values), and enables Continue only once a rate is chosen. NO client money
 * math.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, act } from '@testing-library/react';
import { renderWithIntl } from '@/test-intl';
import type { CartView, ShippingRateView } from '@/lib/cart-types';

// The checkout shipping step MUST use the READ-ONLY rate fetch (loadShippingRates) — never
// estimateShipping, which re-POSTs a placeholder address and would clobber the real one (the bug that
// clamped the flow back to address). We assert estimateShipping is NEVER called.
const loadShippingRates = vi.fn<() => Promise<ShippingRateView[]>>();
const estimateShipping = vi.fn<() => Promise<ShippingRateView[]>>();
const selectShippingRate = vi.fn<(id: string) => Promise<void>>();
let cart: CartView | null = null;
let shippingRates: ShippingRateView[] | null = null;
vi.mock('@/lib/cart-context', () => ({
  useCart: () => ({ cart, shippingRates, loadShippingRates, estimateShipping, selectShippingRate }),
}));

import { CheckoutShipping } from './CheckoutShipping';

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
    shippingAddress: {
      name: 'Marie',
      line1: '12 Rue',
      city: 'Paris',
      postalCode: '75002',
      country: 'FR',
    },
    billingAddress: null,
    shippingRateId: null,
    discountCode: null,
    totals: { subtotal: 1999, shipping: 0, discountTotal: 0, taxTotal: 0, grandTotal: 1999, currency: 'EUR', reverseCharge: false }, // prettier-ignore
    ...over,
  };
}

const RATES: ShippingRateView[] = [
  { id: 'rate-1', name: 'Standard', type: 'flat', amount: 499, currency: 'EUR' },
  { id: 'rate-2', name: 'Express', type: 'flat', amount: 999, currency: 'EUR' },
];

beforeEach(() => {
  loadShippingRates.mockReset().mockResolvedValue(RATES);
  estimateShipping.mockReset().mockResolvedValue(RATES);
  selectShippingRate.mockReset().mockResolvedValue();
  cart = makeCart();
  shippingRates = null;
});

describe('CheckoutShipping', () => {
  it('fetches rates for the cart destination on mount (READ-ONLY) and lists them with server amounts', async () => {
    shippingRates = RATES;
    renderWithIntl(<CheckoutShipping onDone={vi.fn()} locale="en" />, 'en');
    await waitFor(() => expect(loadShippingRates).toHaveBeenCalled());
    // REGRESSION: must NEVER call estimateShipping (which would re-POST a placeholder address and clamp
    // the flow back to the address step). The read-only loadShippingRates leaves the real address intact.
    expect(estimateShipping).not.toHaveBeenCalled();
    expect(screen.getByText(/Standard/)).toBeInTheDocument();
    expect(screen.getByText(/Express/)).toBeInTheDocument();
    // Server amount (499 minor → €4.99) rendered via formatPrice — no client math.
    expect(screen.getByText(/4\.99/)).toBeInTheDocument();
  });

  it('selecting a rate calls selectShippingRate (server recomputes totals)', async () => {
    shippingRates = RATES;
    renderWithIntl(<CheckoutShipping onDone={vi.fn()} locale="en" />, 'en');
    await waitFor(() => expect(screen.getByText(/Standard/)).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByRole('radio', { name: /Standard/i }));
    });
    await waitFor(() => expect(selectShippingRate).toHaveBeenCalledWith('rate-1'));
  });

  it('Continue is disabled until a rate is chosen on the cart', async () => {
    shippingRates = RATES;
    renderWithIntl(<CheckoutShipping onDone={vi.fn()} locale="en" />, 'en');
    await waitFor(() => expect(screen.getByText(/Standard/)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled();
  });

  it('Continue is enabled (and advances) once the cart carries a chosen shippingRateId', async () => {
    cart = makeCart({ shippingRateId: 'rate-1' });
    shippingRates = RATES;
    const onDone = vi.fn();
    renderWithIntl(<CheckoutShipping onDone={onDone} locale="en" />, 'en');
    await waitFor(() => expect(screen.getByText(/Standard/)).toBeInTheDocument());
    const cont = screen.getByRole('button', { name: /continue/i });
    await waitFor(() => expect(cont).toBeEnabled());
    fireEvent.click(cont);
    expect(onDone).toHaveBeenCalled();
  });

  it('shows a "no methods" message when the destination has no rates', async () => {
    loadShippingRates.mockResolvedValue([]);
    shippingRates = [];
    renderWithIntl(<CheckoutShipping onDone={vi.fn()} locale="en" />, 'en');
    await waitFor(() => expect(screen.getByTestId('shipping-none')).toBeInTheDocument());
  });
});
