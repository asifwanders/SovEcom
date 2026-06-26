/**
 * cart-context CHECKOUT-mutator contract. Covers `setEmail`, `setShippingAddress`, `setBillingAddress`,
 * and `associateCustomer` (server-authoritative reverse-charge totals; no client tax math).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import React from 'react';

const request = vi.fn();
vi.mock('./browser-client', () => ({
  createBrowserClient: () => ({ request }),
}));

import { CartProvider, useCart } from './cart-context';
import { serverCart } from './cart-context.test-helpers';

beforeEach(() => {
  request.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('CartProvider — checkout mutators', () => {
  it('setEmail posts the guest email and adopts the server cart', async () => {
    let sentBody: { email?: string } | undefined;
    request.mockImplementation((_m: string, path: string, opts?: { body?: { email?: string } }) => {
      if (path === '/store/v1/carts') return Promise.resolve({ cartId: 'cart-1', currency: 'EUR' });
      if (path === '/store/v1/carts/{cartId}/email') {
        sentBody = opts?.body;
        return Promise.resolve(serverCart({ guestEmail: 'shopper@example.com' }));
      }
      return Promise.reject(new Error(`unexpected ${path}`));
    });

    function EmailProbe() {
      const { cart, setEmail } = useCart();
      return (
        <div>
          <span data-testid="email">{cart?.guestEmail ?? ''}</span>
          <button onClick={() => void setEmail('shopper@example.com').catch(() => {})}>
            email
          </button>
        </div>
      );
    }

    render(
      <CartProvider>
        <EmailProbe />
      </CartProvider>,
    );
    await act(async () => {
      screen.getByText('email').click();
    });
    await waitFor(() =>
      expect(screen.getByTestId('email')).toHaveTextContent('shopper@example.com'),
    );
    expect(sentBody).toEqual({ email: 'shopper@example.com' });
  });

  it('setShippingAddress UNCONDITIONALLY posts the REAL full address, overwriting any placeholder', async () => {
    // Seed: the estimator may have left a placeholder address ("—") on the cart. The checkout address
    // step MUST overwrite it with the real one.
    const placeholder = { name: '—', line1: '—', city: '—', postalCode: '75001', country: 'FR' };
    const real = {
      name: 'Marie Curie',
      line1: '12 Rue de la Paix',
      city: 'Paris',
      postalCode: '75002',
      country: 'FR',
    };
    let sentBody: typeof real | undefined;
    request.mockImplementation((_m: string, path: string, opts?: { body?: typeof real }) => {
      if (path === '/store/v1/carts') return Promise.resolve({ cartId: 'cart-1', currency: 'EUR' });
      if (path === '/store/v1/carts/{cartId}/items') {
        return Promise.resolve(serverCart({ shippingAddress: placeholder }));
      }
      if (path === '/store/v1/carts/{cartId}/shipping-address') {
        sentBody = opts?.body;
        // The server stores exactly what was posted; it returns the cart with the REAL address.
        return Promise.resolve(serverCart({ shippingAddress: opts?.body }));
      }
      return Promise.reject(new Error(`unexpected ${path}`));
    });

    function AddrProbe() {
      const { cart, addItem, setShippingAddress } = useCart();
      const ship = cart?.shippingAddress as { name?: string } | null;
      return (
        <div>
          <span data-testid="ship-name">{ship?.name ?? ''}</span>
          <button onClick={() => void addItem('v1', 1).catch(() => {})}>add</button>
          <button onClick={() => void setShippingAddress(real).catch(() => {})}>ship</button>
        </div>
      );
    }

    render(
      <CartProvider>
        <AddrProbe />
      </CartProvider>,
    );
    // Establish a cart that already carries the placeholder shipping address.
    await act(async () => {
      screen.getByText('add').click();
    });
    await waitFor(() => expect(screen.getByTestId('ship-name')).toHaveTextContent('—'));

    // The checkout address step posts the real address.
    await act(async () => {
      screen.getByText('ship').click();
    });
    // After CheckoutAddress, the cart shipping address is the REAL one — NEVER the "—" placeholder.
    await waitFor(() => expect(screen.getByTestId('ship-name')).toHaveTextContent('Marie Curie'));
    expect(screen.getByTestId('ship-name')).not.toHaveTextContent('—');
    // The full real body was sent verbatim (no placeholder fields leaked through).
    expect(sentBody).toEqual(real);
  });

  it('setBillingAddress posts the address and adopts the server cart', async () => {
    const billing = {
      name: 'ACME GmbH',
      line1: 'Hauptstr 1',
      city: 'Berlin',
      postalCode: '10115',
      country: 'DE',
    };
    let sentBody: typeof billing | undefined;
    request.mockImplementation((_m: string, path: string, opts?: { body?: typeof billing }) => {
      if (path === '/store/v1/carts') return Promise.resolve({ cartId: 'cart-1', currency: 'EUR' });
      if (path === '/store/v1/carts/{cartId}/billing-address') {
        sentBody = opts?.body;
        return Promise.resolve(serverCart({ billingAddress: opts?.body }));
      }
      return Promise.reject(new Error(`unexpected ${path}`));
    });

    function BillProbe() {
      const { cart, setBillingAddress } = useCart();
      const bill = cart?.billingAddress as { city?: string } | null;
      return (
        <div>
          <span data-testid="bill-city">{bill?.city ?? ''}</span>
          <button onClick={() => void setBillingAddress(billing).catch(() => {})}>bill</button>
        </div>
      );
    }

    render(
      <CartProvider>
        <BillProbe />
      </CartProvider>,
    );
    await act(async () => {
      screen.getByText('bill').click();
    });
    await waitFor(() => expect(screen.getByTestId('bill-city')).toHaveTextContent('Berlin'));
    expect(sentBody).toEqual(billing);
  });

  it('associateCustomer links the customer; the server returns the cart with reverse-charge totals (taxTotal 0, no client math)', async () => {
    request.mockImplementation((_m: string, path: string) => {
      if (path === '/store/v1/carts') return Promise.resolve({ cartId: 'cart-1', currency: 'EUR' });
      if (path === '/store/v1/carts/{cartId}/items') return Promise.resolve(serverCart());
      if (path === '/store/v1/carts/{cartId}/customer') {
        // After association the server's tax engine sees the B2B/VIES customer on a cross-border EU
        // sale → reverse-charge: taxTotal is 0 (server-computed); the UI never derives this.
        return Promise.resolve(
          serverCart({
            customerId: 'cust-9',
            totals: {
              subtotal: 1999,
              shipping: 0,
              discountTotal: 0,
              taxTotal: 0,
              grandTotal: 1999,
              currency: 'EUR',
            },
          }),
        );
      }
      return Promise.reject(new Error(`unexpected ${path}`));
    });

    function AssocProbe() {
      const { cart, addItem, associateCustomer } = useCart();
      return (
        <div>
          <span data-testid="cust">{cart?.customerId ?? ''}</span>
          <span data-testid="tax">{cart?.totals.taxTotal ?? ''}</span>
          <button onClick={() => void addItem('v1', 1).catch(() => {})}>add</button>
          <button onClick={() => void associateCustomer().catch(() => {})}>assoc</button>
        </div>
      );
    }

    render(
      <CartProvider>
        <AssocProbe />
      </CartProvider>,
    );
    await act(async () => {
      screen.getByText('add').click();
    });
    await act(async () => {
      screen.getByText('assoc').click();
    });
    await waitFor(() => expect(screen.getByTestId('cust')).toHaveTextContent('cust-9'));
    expect(screen.getByTestId('tax')).toHaveTextContent('0');
  });

  it('recomputeTotals re-POSTs the cart CURRENT shipping address, forcing a server recompute (H1: reverse-charge after VAT entry)', async () => {
    // The cart already holds the REAL address (from the address step). After an in-checkout VAT change
    // (PATCH /me flips vat_validated server-side), a plain GET would not recompute tax — so recomputeTotals
    // re-POSTs the SAME real address, which the server recomputes against the now-validated VAT → reverse
    // charge. We assert it re-posts the EXACT stored address and adopts the recomputed totals.
    const real = {
      name: 'Marie Curie',
      line1: '12 Rue de la Paix',
      city: 'Paris',
      postalCode: '75002',
      country: 'FR',
    };
    let recomputePostBody: typeof real | undefined;
    request.mockImplementation((_m: string, path: string, opts?: { body?: typeof real }) => {
      if (path === '/store/v1/carts') return Promise.resolve({ cartId: 'cart-1', currency: 'EUR' });
      if (path === '/store/v1/carts/{cartId}/items') {
        // Seed the cart with the real shipping address + VAT-charged totals (pre-validation).
        return Promise.resolve(
          serverCart({
            shippingAddress: real,
            totals: { subtotal: 1999, shipping: 0, discountTotal: 0, taxTotal: 400, grandTotal: 2399, currency: 'EUR', reverseCharge: false }, // prettier-ignore
          }),
        );
      }
      if (path === '/store/v1/carts/{cartId}/shipping-address') {
        recomputePostBody = opts?.body;
        // Server recomputed against the now-validated VAT → reverse charge: taxTotal 0, flag true.
        return Promise.resolve(
          serverCart({
            shippingAddress: real,
            totals: { subtotal: 1999, shipping: 0, discountTotal: 0, taxTotal: 0, grandTotal: 1999, currency: 'EUR', reverseCharge: true }, // prettier-ignore
          }),
        );
      }
      return Promise.reject(new Error(`unexpected ${path}`));
    });

    function RecomputeProbe() {
      const { cart, addItem, recomputeTotals } = useCart();
      return (
        <div>
          <span data-testid="tax">{cart?.totals.taxTotal ?? ''}</span>
          <span data-testid="rc">{cart ? String(cart.totals.reverseCharge) : ''}</span>
          <button onClick={() => void addItem('v1', 1).catch(() => {})}>add</button>
          <button onClick={() => void recomputeTotals().catch(() => {})}>recompute</button>
        </div>
      );
    }

    render(
      <CartProvider>
        <RecomputeProbe />
      </CartProvider>,
    );
    await act(async () => {
      screen.getByText('add').click();
    });
    await waitFor(() => expect(screen.getByTestId('tax')).toHaveTextContent('400'));

    await act(async () => {
      screen.getByText('recompute').click();
    });
    // After recompute: the SERVER's recomputed totals are adopted — taxTotal 0, reverseCharge true.
    await waitFor(() => expect(screen.getByTestId('rc')).toHaveTextContent('true'));
    expect(screen.getByTestId('tax')).toHaveTextContent('0');
    // It re-posted the EXACT real address the cart already held (no placeholder, no reconstruction).
    expect(recomputePostBody).toEqual(real);
  });

  it('recomputeTotals PRESERVES the selected shipping rate + non-zero cost while refreshing tax (regression)', async () => {
    // Regression for the H1 re-POST: the cart already has a SELECTED shipping rate with a NON-ZERO cost.
    // Re-POSTing the address to refresh tax must NOT drop the shipping selection/cost — the server
    // recomputes returning the SAME shippingRateId + shipping:499 (plus the new reverse-charge tax). We
    // assert the adopted cart retains the rate + cost AND picks up reverseCharge — both on one adoption.
    const real = {
      name: 'Marie Curie',
      line1: '12 Rue de la Paix',
      city: 'Paris',
      postalCode: '75002',
      country: 'FR',
    };
    request.mockImplementation((_m: string, path: string) => {
      if (path === '/store/v1/carts') return Promise.resolve({ cartId: 'cart-1', currency: 'EUR' });
      if (path === '/store/v1/carts/{cartId}/items') {
        // Seed: real address + a CHOSEN rate (rate-1) with a non-zero shipping cost, VAT still charged.
        return Promise.resolve(
          serverCart({
            shippingAddress: real,
            shippingRateId: 'rate-1',
            totals: { subtotal: 1999, shipping: 499, discountTotal: 0, taxTotal: 400, grandTotal: 2898, currency: 'EUR', reverseCharge: false }, // prettier-ignore
          }),
        );
      }
      if (path === '/store/v1/carts/{cartId}/shipping-address') {
        // Server recomputes against the now-validated VAT → reverse charge (taxTotal 0, flag true) but
        // KEEPS the selected rate + its 499 cost (re-posting the address never clears the shipping method).
        return Promise.resolve(
          serverCart({
            shippingAddress: real,
            shippingRateId: 'rate-1',
            totals: { subtotal: 1999, shipping: 499, discountTotal: 0, taxTotal: 0, grandTotal: 2498, currency: 'EUR', reverseCharge: true }, // prettier-ignore
          }),
        );
      }
      return Promise.reject(new Error(`unexpected ${path}`));
    });

    function RecomputeProbe() {
      const { cart, addItem, recomputeTotals } = useCart();
      return (
        <div>
          <span data-testid="rate">{cart?.shippingRateId ?? ''}</span>
          <span data-testid="shipping">{cart?.totals.shipping ?? ''}</span>
          <span data-testid="grand">{cart?.totals.grandTotal ?? ''}</span>
          <span data-testid="rc">{cart ? String(cart.totals.reverseCharge) : ''}</span>
          <button onClick={() => void addItem('v1', 1).catch(() => {})}>add</button>
          <button onClick={() => void recomputeTotals().catch(() => {})}>recompute</button>
        </div>
      );
    }

    render(
      <CartProvider>
        <RecomputeProbe />
      </CartProvider>,
    );
    await act(async () => {
      screen.getByText('add').click();
    });
    await waitFor(() => expect(screen.getByTestId('shipping')).toHaveTextContent('499'));

    await act(async () => {
      screen.getByText('recompute').click();
    });
    // The shipping selection + its NON-ZERO cost SURVIVE the recompute re-POST (not lost)...
    await waitFor(() => expect(screen.getByTestId('rc')).toHaveTextContent('true'));
    expect(screen.getByTestId('rate')).toHaveTextContent('rate-1');
    expect(screen.getByTestId('shipping')).toHaveTextContent('499');
    // ...and the grand total reflects shipping (499) + the now-zero tax — all server-authoritative.
    expect(screen.getByTestId('grand')).toHaveTextContent('2498');
  });

  it('recomputeTotals is a no-op when no real shipping address is set (no destination → tax stays 0)', async () => {
    let shippingAddressPosts = 0;
    request.mockImplementation((_m: string, path: string) => {
      if (path === '/store/v1/carts') return Promise.resolve({ cartId: 'cart-1', currency: 'EUR' });
      if (path === '/store/v1/carts/{cartId}/items') return Promise.resolve(serverCart()); // shippingAddress null
      if (path === '/store/v1/carts/{cartId}/shipping-address') {
        shippingAddressPosts += 1;
        return Promise.resolve(serverCart());
      }
      return Promise.reject(new Error(`unexpected ${path}`));
    });

    function RecomputeProbe() {
      const { addItem, recomputeTotals } = useCart();
      return (
        <div>
          <button onClick={() => void addItem('v1', 1).catch(() => {})}>add</button>
          <button onClick={() => void recomputeTotals().catch(() => {})}>recompute</button>
        </div>
      );
    }

    render(
      <CartProvider>
        <RecomputeProbe />
      </CartProvider>,
    );
    await act(async () => {
      screen.getByText('add').click();
    });
    await act(async () => {
      screen.getByText('recompute').click();
    });
    // No shipping address on the cart → nothing to re-post; recomputeTotals does not call the endpoint.
    expect(shippingAddressPosts).toBe(0);
  });
});
