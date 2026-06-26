/**
 * CheckoutVat + B2B reverse-charge display contract.
 *
 * Entering a VAT number triggers the customer-profile update (PATCH /me) + a cart re-read; the
 * reverse-charge note is shown ONLY when the server actually applied it (VIES-validated B2B + server
 * `taxTotal === 0`). The test mocks the server returning reverse-charge totals — there is NO client tax
 * math here: the component reads the server's `taxTotal`, it never computes a tax.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, act } from '@testing-library/react';
import { renderWithIntl } from '@/test-intl';
import type { CartView } from '@/lib/cart-types';
import type { AuthCustomer } from '@/lib/auth-context';

const updateVatNumber = vi.fn<(v: string) => Promise<void>>();
const recomputeTotals = vi.fn<() => Promise<void>>();
let customer: AuthCustomer | null = null;
let isAuthenticated = false;
let cart: CartView | null = null;
vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ customer, isAuthenticated, updateVatNumber }),
}));
vi.mock('@/lib/cart-context', () => ({
  useCart: () => ({ cart, recomputeTotals }),
}));

import { CheckoutVat } from './CheckoutVat';

function makeCart(taxTotal: number, reverseCharge = false): CartView {
  return {
    id: 'c1',
    customerId: 'cust-9',
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
    totals: { subtotal: 1999, shipping: 0, discountTotal: 0, taxTotal, grandTotal: 1999 + taxTotal, currency: 'EUR', reverseCharge }, // prettier-ignore
  };
}

beforeEach(() => {
  updateVatNumber.mockReset().mockResolvedValue();
  recomputeTotals.mockReset().mockResolvedValue();
  customer = null;
  isAuthenticated = false;
  cart = makeCart(400);
});

describe('CheckoutVat', () => {
  it('renders nothing for a guest or a non-B2B customer', () => {
    const { container } = renderWithIntl(<CheckoutVat />, 'en');
    expect(container).toBeEmptyDOMElement();

    isAuthenticated = true;
    customer = { id: 'c', email: 'a@b.com', isB2b: false };
    const { container: c2 } = renderWithIntl(<CheckoutVat />, 'en');
    expect(c2).toBeEmptyDOMElement();
  });

  it('B2B: entering a VAT number PATCHes the profile then forces a SERVER recompute (not a plain GET)', async () => {
    isAuthenticated = true;
    customer = { id: 'c', email: 'a@b.com', isB2b: true, vatNumber: null, vatValidated: false };
    renderWithIntl(<CheckoutVat />, 'en');
    fireEvent.change(screen.getByLabelText('EU VAT number'), {
      target: { value: 'FR12345678901' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /apply vat number/i }));
    });
    await waitFor(() => expect(updateVatNumber).toHaveBeenCalledWith('FR12345678901'));
    // After the VIES PATCH we must FORCE a server tax recompute (recomputeTotals), NOT a plain
    // refresh() GET — the GET would leave totals.taxTotal/reverseCharge stale.
    await waitFor(() => expect(recomputeTotals).toHaveBeenCalled());
    // Ordering: the recompute runs AFTER the profile patch (so the recompute reads the validated VAT).
    expect(updateVatNumber.mock.invocationCallOrder[0]).toBeLessThan(
      recomputeTotals.mock.invocationCallOrder[0]!,
    );
  });

  it('after VAT validates to reverse charge, the recompute-adopted cart shows reverseCharge=true + taxTotal=0 and the note renders', async () => {
    isAuthenticated = true;
    customer = { id: 'c', email: 'a@b.com', isB2b: true, vatNumber: null, vatValidated: false };
    // The recompute (mocked) is what flips the displayed cart: simulate the server returning reverse-charge
    // totals + the now-validated customer, exactly as the real recomputeTotals adopts. The component
    // re-renders off this state change (useState in the consumer is driven by the live module `let`s,
    // re-read by the mocked useAuth/useCart on the post-await re-render).
    recomputeTotals.mockImplementation(async () => {
      cart = makeCart(0, /* reverseCharge */ true);
      customer = {
        id: 'c',
        email: 'a@b.com',
        isB2b: true,
        vatNumber: 'FR12345678901',
        vatValidated: true,
      };
    });
    renderWithIntl(<CheckoutVat />, 'en');
    fireEvent.change(screen.getByLabelText('EU VAT number'), {
      target: { value: 'FR12345678901' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /apply vat number/i }));
    });
    await waitFor(() => expect(recomputeTotals).toHaveBeenCalled());
    // The recompute adopted reverse-charge totals (server-authoritative): flag true, tax 0 — BEFORE the
    // review/payment step. The note renders from the SERVER flag, never a taxTotal===0 inference.
    expect(cart!.totals.reverseCharge).toBe(true);
    expect(cart!.totals.taxTotal).toBe(0);
    await waitFor(() =>
      expect(screen.getByTestId('reverse-charge')).toHaveTextContent(/no VAT is charged/i),
    );
  });

  it('shows the reverse-charge note ONLY when the SERVER flagged reverseCharge (VIES-validated B2B)', () => {
    isAuthenticated = true;
    customer = {
      id: 'c',
      email: 'a@b.com',
      isB2b: true,
      vatNumber: 'FR12345678901',
      vatValidated: true,
    };
    // Server APPLIED reverse charge: the authoritative flag is true (taxTotal 0 rides along, but the UI
    // reads the FLAG, not taxTotal === 0).
    cart = makeCart(0, /* reverseCharge */ true);
    renderWithIntl(<CheckoutVat />, 'en');
    expect(screen.getByTestId('reverse-charge')).toHaveTextContent(/no VAT is charged/i);
  });

  it('does NOT show reverse-charge while the server is still charging tax (taxTotal > 0, flag false)', () => {
    isAuthenticated = true;
    customer = {
      id: 'c',
      email: 'a@b.com',
      isB2b: true,
      vatNumber: 'FR12345678901',
      vatValidated: true,
    };
    cart = makeCart(400, /* reverseCharge */ false); // server still charging VAT
    renderWithIntl(<CheckoutVat />, 'en');
    expect(screen.queryByTestId('reverse-charge')).toBeNull();
  });

  it('does NOT show reverse-charge on the former FALSE-POSITIVE: taxTotal===0 but the server did NOT flag it', () => {
    // `none` regime / no-destination / zero-rated / non-EU export: taxTotal is 0 but reverseCharge is
    // false. The OLD `taxTotal === 0` inference would wrongly show the note here; the flag fixes it.
    isAuthenticated = true;
    customer = {
      id: 'c',
      email: 'a@b.com',
      isB2b: true,
      vatNumber: 'FR12345678901',
      vatValidated: true,
    };
    cart = makeCart(0, /* reverseCharge */ false);
    renderWithIntl(<CheckoutVat />, 'en');
    expect(screen.queryByTestId('reverse-charge')).toBeNull();
  });

  it('shows the "not validated" hint when a number is on file but VIES did not validate it', () => {
    isAuthenticated = true;
    customer = {
      id: 'c',
      email: 'a@b.com',
      isB2b: true,
      vatNumber: 'BADVAT',
      vatValidated: false,
    };
    cart = makeCart(400);
    renderWithIntl(<CheckoutVat />, 'en');
    expect(screen.getByTestId('vat-unvalidated')).toBeInTheDocument();
    expect(screen.queryByTestId('reverse-charge')).toBeNull();
  });

  it('localizes the reverse-charge note in French', () => {
    isAuthenticated = true;
    customer = {
      id: 'c',
      email: 'a@b.com',
      isB2b: true,
      vatNumber: 'FR12345678901',
      vatValidated: true,
    };
    cart = makeCart(0, /* reverseCharge */ true);
    renderWithIntl(<CheckoutVat />, 'fr');
    expect(screen.getByTestId('reverse-charge')).toHaveTextContent(/autoliquidation/i);
  });
});
