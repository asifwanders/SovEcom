import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, act } from '@testing-library/react';
import { SovEcomApiError } from '@sovecom/client-js';
import { renderWithIntl } from '@/test-intl';
import type { CartView } from '@/lib/cart-types';

// Drive useCart() per test: `cart` (for the applied-code branch) + applyDiscount/removeDiscount.
let cart: CartView | null = null;
const applyDiscount = vi.fn<(code: string) => Promise<void>>();
const removeDiscount = vi.fn<(code: string) => Promise<void>>();
vi.mock('@/lib/cart-context', () => ({
  useCart: () => ({ cart, applyDiscount, removeDiscount }),
}));

import { DiscountForm } from './DiscountForm';

function makeCart(over: Partial<CartView> = {}): CartView {
  return {
    id: 'cart-1',
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
        productTitle: 'Blue Tee',
        variantTitle: 'Medium',
        options: { Size: 'M' },
        sku: 'TEE-M',
        productSlug: 'blue-tee',
      },
    ],
    shippingAddress: null,
    billingAddress: null,
    shippingRateId: null,
    discountCode: null,
    totals: {
      subtotal: 1999,
      shipping: 0,
      discountTotal: 0,
      taxTotal: 0,
      grandTotal: 1999,
      currency: 'EUR',
      reverseCharge: false,
    },
    ...over,
  };
}

beforeEach(() => {
  cart = makeCart();
  applyDiscount.mockReset();
  applyDiscount.mockResolvedValue();
  removeDiscount.mockReset();
  removeDiscount.mockResolvedValue();
});

describe('DiscountForm', () => {
  it('applies a typed code via applyDiscount', async () => {
    renderWithIntl(<DiscountForm />, 'en');
    fireEvent.change(screen.getByLabelText(/discount code/i), { target: { value: 'SAVE10' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^apply$/i }));
    });
    await waitFor(() => expect(applyDiscount).toHaveBeenCalledWith('SAVE10'));
  });

  it('shows a clear, non-destructive error on a 422 (invalid/ineligible code) and does NOT touch the cart', async () => {
    applyDiscount.mockRejectedValueOnce(
      new SovEcomApiError(422, 'Unprocessable Entity', undefined),
    );
    renderWithIntl(<DiscountForm />, 'en');
    fireEvent.change(screen.getByLabelText(/discount code/i), { target: { value: 'BADCODE' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^apply$/i }));
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(/not valid|cannot be applied/i);
    // The field still allows a retry (non-destructive) and the input is still present.
    expect(screen.getByLabelText(/discount code/i)).toBeInTheDocument();
  });

  it('shows a generic error on a non-422 failure', async () => {
    applyDiscount.mockRejectedValueOnce(new SovEcomApiError(500, 'Server Error', undefined));
    renderWithIntl(<DiscountForm />, 'en');
    fireEvent.change(screen.getByLabelText(/discount code/i), { target: { value: 'SAVE10' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^apply$/i }));
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not apply/i);
  });

  it('does not call applyDiscount for a blank code', async () => {
    renderWithIntl(<DiscountForm />, 'en');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^apply$/i }));
    });
    expect(applyDiscount).not.toHaveBeenCalled();
  });

  it('shows the applied code + a remove control when the authoritative cart has a discount', () => {
    cart = makeCart({
      discountCode: 'SAVE10',
      totals: { ...makeCart().totals, discountTotal: 200 },
    });
    renderWithIntl(<DiscountForm />, 'en');
    expect(screen.getByTestId('discount-applied')).toHaveTextContent(/SAVE10/);
    expect(screen.getByRole('button', { name: /remove/i })).toBeInTheDocument();
    // No entry field while a code is applied.
    expect(screen.queryByLabelText(/discount code/i)).toBeNull();
  });

  it('remove calls removeDiscount with the applied code', async () => {
    cart = makeCart({ discountCode: 'SAVE10' });
    renderWithIntl(<DiscountForm />, 'en');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /remove/i }));
    });
    await waitFor(() => expect(removeDiscount).toHaveBeenCalledWith('SAVE10'));
  });

  it('localizes the apply label in French', () => {
    renderWithIntl(<DiscountForm />, 'fr');
    expect(screen.getByRole('button', { name: /appliquer/i })).toBeInTheDocument();
  });
});
