/**
 * cart-context SHIPPING-ESTIMATE contract. Server-authoritative:
 * rate amounts + totals come from the API, never client money math.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import React from 'react';

const request = vi.fn();
vi.mock('./browser-client', () => ({
  createBrowserClient: () => ({ request }),
}));

import { CartProvider } from './cart-context';
import { serverCart, Probe } from './cart-context.test-helpers';

beforeEach(() => {
  request.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('CartProvider — shipping estimate', () => {
  it('estimateShipping sets the destination, adopts the server cart, then returns the available rates', async () => {
    request.mockImplementation((_m: string, path: string) => {
      if (path === '/store/v1/carts') return Promise.resolve({ cartId: 'cart-1', currency: 'EUR' });
      if (path === '/store/v1/carts/{cartId}/shipping-address') {
        // Server recomputes totals when an address is set (here still 0 shipping until a method picked).
        return Promise.resolve(serverCart());
      }
      if (path === '/store/v1/carts/{cartId}/shipping-rates') {
        return Promise.resolve([
          { id: 'rate-1', name: 'Standard', type: 'flat', amount: 499, currency: 'EUR' },
          { id: 'rate-2', name: 'Express', type: 'flat', amount: 999, currency: 'EUR' },
        ]);
      }
      return Promise.reject(new Error(`unexpected ${path}`));
    });

    render(
      <CartProvider>
        <Probe />
      </CartProvider>,
    );
    await act(async () => {
      screen.getByText('estimate').click();
    });
    await waitFor(() => expect(screen.getByTestId('rateCount')).toHaveTextContent('2'));
    expect(screen.getByTestId('rateNames')).toHaveTextContent('Standard,Express');
  });

  it('selectShippingRate adopts the server cart with the recomputed shipping in authoritative totals', async () => {
    request.mockImplementation((_m: string, path: string) => {
      if (path === '/store/v1/carts') return Promise.resolve({ cartId: 'cart-1', currency: 'EUR' });
      if (path === '/store/v1/carts/{cartId}/shipping-address')
        return Promise.resolve(serverCart());
      if (path === '/store/v1/carts/{cartId}/shipping-rates') {
        return Promise.resolve([
          { id: 'rate-1', name: 'Standard', type: 'flat', amount: 499, currency: 'EUR' },
        ]);
      }
      if (path === '/store/v1/carts/{cartId}/shipping-method') {
        // Server folds the chosen rate's cost (499) into the authoritative totals.
        return Promise.resolve(
          serverCart({
            shippingRateId: 'rate-1',
            totals: {
              subtotal: 1999,
              shipping: 499,
              discountTotal: 0,
              taxTotal: 0,
              grandTotal: 2498,
              currency: 'EUR',
            },
          }),
        );
      }
      return Promise.reject(new Error(`unexpected ${path}`));
    });

    render(
      <CartProvider>
        <Probe />
      </CartProvider>,
    );
    // Establish the cart id via an estimate first.
    await act(async () => {
      screen.getByText('estimate').click();
    });
    await waitFor(() => expect(screen.getByTestId('rateCount')).toHaveTextContent('1'));

    await act(async () => {
      screen.getByText('selectRate').click();
    });
    // The shipping cost + grand total are the SERVER values — the client never computed them.
    await waitFor(() => expect(screen.getByTestId('shippingTotal')).toHaveTextContent('499'));
    expect(screen.getByTestId('grand')).toHaveTextContent('2498');
    expect(screen.getByTestId('shippingRateId')).toHaveTextContent('rate-1');
  });

  it('loadShippingRates GETs rates for the current address WITHOUT posting one (real address preserved)', async () => {
    const posted: string[] = [];
    request.mockImplementation((_m: string, path: string) => {
      if (path === '/store/v1/carts') return Promise.resolve({ cartId: 'cart-1', currency: 'EUR' });
      if (path === '/store/v1/carts/{cartId}/shipping-address') {
        posted.push(path); // a POST here would clobber the real address — must NOT happen
        return Promise.resolve(serverCart());
      }
      if (path === '/store/v1/carts/{cartId}/shipping-rates') {
        return Promise.resolve([
          { id: 'rate-1', name: 'Standard', type: 'flat', amount: 499, currency: 'EUR' },
        ]);
      }
      return Promise.reject(new Error(`unexpected ${path}`));
    });

    render(
      <CartProvider>
        <Probe />
      </CartProvider>,
    );
    await act(async () => {
      screen.getByText('loadRates').click();
    });
    await waitFor(() => expect(screen.getByTestId('rateCount')).toHaveTextContent('1'));
    expect(screen.getByTestId('rateNames')).toHaveTextContent('Standard');
    // The read-only rate fetch must never POST a shipping address.
    expect(posted).toEqual([]);
  });

  it('estimateShipping propagates a server error (cart unchanged on failure)', async () => {
    request.mockImplementation((_m: string, path: string) => {
      if (path === '/store/v1/carts') return Promise.resolve({ cartId: 'cart-1', currency: 'EUR' });
      if (path === '/store/v1/carts/{cartId}/shipping-address') {
        return Promise.reject(new Error('invalid country'));
      }
      return Promise.reject(new Error(`unexpected ${path}`));
    });

    render(
      <CartProvider>
        <Probe />
      </CartProvider>,
    );
    await act(async () => {
      screen.getByText('estimate').click();
    });
    // No rates adopted; the failure left the rates state untouched (empty).
    await waitFor(() => expect(screen.getByTestId('rateCount')).toHaveTextContent(''));
  });
});
