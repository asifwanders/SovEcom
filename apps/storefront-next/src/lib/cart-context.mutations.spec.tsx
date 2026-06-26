/**
 * cart-context MUTATIONS contract. Covers add/update/remove, optimistic updates + rollback,
 * serialized-mutation concurrency, `ensureCartId` idempotency, and discount apply/remove.
 * Shipping + checkout mutators live in their sibling spec files.
 *
 * The mechanism under test:
 *   - each mutation calls the API then the context adopts the AUTHORITATIVE server cart (incl. totals)
 *     from the response — money totals are NEVER computed client-side;
 *   - add/quantity may be OPTIMISTIC (item count/qty updates before the response) but roll back on
 *     error, and the post-mutation totals always come from the server re-fetch, not local math;
 *   - the cart id flows from the create response body (`{cartId,currency}`); the `sov_cart` httpOnly
 *     cookie is set/sent by the API + credentialed browser-client, so the context only tracks the id.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import React from 'react';

const request = vi.fn();
vi.mock('./browser-client', () => ({
  createBrowserClient: () => ({ request }),
}));

import { CartProvider, useCart } from './cart-context';
import { serverCart, Probe } from './cart-context.test-helpers';

beforeEach(() => {
  request.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('CartProvider — mutations', () => {
  it('addItem re-fetches the authoritative cart and adopts server totals (not client math)', async () => {
    request.mockImplementation((_m: string, path: string) => {
      if (path === '/store/v1/carts') return Promise.resolve({ cartId: 'cart-1', currency: 'EUR' });
      if (path === '/store/v1/carts/{cartId}/items') {
        return Promise.resolve(
          serverCart({
            items: [
              { id: 'li-1', variantId: 'v1', quantity: 1, unitPriceAmount: 1999, currency: 'EUR' },
            ],
            totals: {
              subtotal: 1999,
              shipping: 0,
              discountTotal: 0,
              taxTotal: 0,
              grandTotal: 2499,
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
    await act(async () => {
      screen.getByText('add').click();
    });
    // grandTotal is the SERVER value (2499 — includes a server-only fee/tax the client never computes).
    await waitFor(() => expect(screen.getByTestId('grand')).toHaveTextContent('2499'));
    expect(screen.getByTestId('count')).toHaveTextContent('1');
  });

  it('updateItem optimistically bumps the quantity, then settles on server totals', async () => {
    let resolveUpdate!: (v: unknown) => void;
    request.mockImplementation((_m: string, path: string) => {
      if (path === '/store/v1/carts') return Promise.resolve({ cartId: 'cart-1', currency: 'EUR' });
      if (path === '/store/v1/carts/{cartId}/items') return Promise.resolve(serverCart());
      if (path === '/store/v1/carts/{cartId}/items/{itemId}') {
        return new Promise((res) => {
          resolveUpdate = res;
        });
      }
      return Promise.reject(new Error(`unexpected ${path}`));
    });

    render(
      <CartProvider>
        <Probe />
      </CartProvider>,
    );
    // Seed a cart with one line item via add.
    await act(async () => {
      screen.getByText('add').click();
    });
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('1'));

    // Fire the update; the optimistic qty (5) should reflect in the count BEFORE the server resolves.
    await act(async () => {
      screen.getByText('update').click();
    });
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('5'));

    // Server settles with authoritative totals.
    await act(async () => {
      resolveUpdate(
        serverCart({
          items: [
            { id: 'li-1', variantId: 'v1', quantity: 5, unitPriceAmount: 1999, currency: 'EUR' },
          ],
          totals: {
            subtotal: 9995,
            shipping: 0,
            discountTotal: 0,
            taxTotal: 0,
            grandTotal: 9995,
            currency: 'EUR',
          },
        }),
      );
    });
    await waitFor(() => expect(screen.getByTestId('grand')).toHaveTextContent('9995'));
    expect(screen.getByTestId('count')).toHaveTextContent('5');
  });

  it('rolls back the optimistic quantity when the update fails', async () => {
    request.mockImplementation((_m: string, path: string) => {
      if (path === '/store/v1/carts') return Promise.resolve({ cartId: 'cart-1', currency: 'EUR' });
      if (path === '/store/v1/carts/{cartId}/items') return Promise.resolve(serverCart());
      if (path === '/store/v1/carts/{cartId}/items/{itemId}') {
        return Promise.reject(new Error('stock unavailable'));
      }
      return Promise.reject(new Error(`unexpected ${path}`));
    });

    render(
      <CartProvider>
        <Probe />
      </CartProvider>,
    );
    await act(async () => {
      screen.getByText('add').click();
    });
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('1'));

    await act(async () => {
      screen.getByText('update').click();
    });
    // After the failure, the optimistic qty (5) is rolled back to the previous authoritative qty (1).
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('1'));
    // Totals remain the last server value — never a client-computed figure.
    expect(screen.getByTestId('grand')).toHaveTextContent('1999');
  });

  // ── Concurrency: serialized mutations, no lost updates (fix 1) ──────────────────────────────────

  it('two overlapping updates on different lines both land — the later authoritative cart wins, no lost update', async () => {
    // Seed a two-line cart, then fire update(li-1) and update(li-2) back-to-back. Mutations are
    // serialized, so the second runs after the first settles; the FINAL authoritative cart must
    // reflect BOTH server updates — neither is clobbered by a stale rollback/snapshot.
    const twoLine = (q1: number, q2: number, grand: number) =>
      serverCart({
        items: [
          { id: 'li-1', variantId: 'v1', quantity: q1, unitPriceAmount: 1000, currency: 'EUR' },
          { id: 'li-2', variantId: 'v2', quantity: q2, unitPriceAmount: 1000, currency: 'EUR' },
        ],
        totals: {
          subtotal: grand,
          shipping: 0,
          discountTotal: 0,
          taxTotal: 0,
          grandTotal: grand,
          currency: 'EUR',
        },
      });

    request.mockImplementation(
      (
        _m: string,
        path: string,
        opts?: { path?: { itemId?: string }; body?: { quantity?: number } },
      ) => {
        if (path === '/store/v1/carts')
          return Promise.resolve({ cartId: 'cart-1', currency: 'EUR' });
        if (path === '/store/v1/carts/{cartId}/items') return Promise.resolve(twoLine(1, 1, 2000));
        if (path === '/store/v1/carts/{cartId}/items/{itemId}') {
          // Server echoes the new qty for the targeted line, keeping the other line as-is.
          const id = opts?.path?.itemId;
          const q = opts?.body?.quantity ?? 1;
          if (id === 'li-1') return Promise.resolve(twoLine(q, 1, q * 1000 + 1000));
          if (id === 'li-2') return Promise.resolve(twoLine(5, q, 5000 + q * 1000));
        }
        return Promise.reject(new Error(`unexpected ${path}`));
      },
    );

    function TwoLineProbe() {
      const { updateItem } = useCart();
      return (
        <button
          onClick={() => {
            void updateItem('li-1', 5).catch(() => {});
            void updateItem('li-2', 3).catch(() => {});
          }}
        >
          both
        </button>
      );
    }

    render(
      <CartProvider>
        <Probe />
        <TwoLineProbe />
      </CartProvider>,
    );
    await act(async () => {
      screen.getByText('add').click();
    });
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('2'));

    await act(async () => {
      screen.getByText('both').click();
    });

    // Both updates landed: li-1=5 AND li-2=3. The second update did NOT clobber the first.
    await waitFor(() => expect(screen.getByTestId('qty-li-2')).toHaveTextContent('3'));
    expect(screen.getByTestId('qty-li-1')).toHaveTextContent('5');
    // Totals are the FINAL server value (5000 + 3000), never client math.
    expect(screen.getByTestId('grand')).toHaveTextContent('8000');
  });

  it('a failed update does NOT clobber a concurrent successful update on another line', async () => {
    const twoLine = (q1: number, q2: number) =>
      serverCart({
        items: [
          { id: 'li-1', variantId: 'v1', quantity: q1, unitPriceAmount: 1000, currency: 'EUR' },
          { id: 'li-2', variantId: 'v2', quantity: q2, unitPriceAmount: 1000, currency: 'EUR' },
        ],
        totals: {
          subtotal: (q1 + q2) * 1000,
          shipping: 0,
          discountTotal: 0,
          taxTotal: 0,
          grandTotal: (q1 + q2) * 1000,
          currency: 'EUR',
        },
      });

    request.mockImplementation(
      (
        _m: string,
        path: string,
        opts?: { path?: { itemId?: string }; body?: { quantity?: number } },
      ) => {
        if (path === '/store/v1/carts')
          return Promise.resolve({ cartId: 'cart-1', currency: 'EUR' });
        if (path === '/store/v1/carts/{cartId}/items') return Promise.resolve(twoLine(1, 1));
        if (path === '/store/v1/carts/{cartId}/items/{itemId}') {
          const id = opts?.path?.itemId;
          if (id === 'li-2') return Promise.reject(new Error('stock unavailable')); // this one fails
          if (id === 'li-1') return Promise.resolve(twoLine(opts?.body?.quantity ?? 1, 1));
        }
        return Promise.reject(new Error(`unexpected ${path}`));
      },
    );

    function TwoLineProbe() {
      const { updateItem } = useCart();
      return (
        <button
          onClick={() => {
            void updateItem('li-1', 4).catch(() => {});
            void updateItem('li-2', 9).catch(() => {});
          }}
        >
          both
        </button>
      );
    }

    render(
      <CartProvider>
        <Probe />
        <TwoLineProbe />
      </CartProvider>,
    );
    await act(async () => {
      screen.getByText('add').click();
    });
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('2'));

    await act(async () => {
      screen.getByText('both').click();
    });

    // li-1's successful update (4) survives; li-2's failed optimistic bump rolls back to 1.
    await waitFor(() => expect(screen.getByTestId('qty-li-1')).toHaveTextContent('4'));
    expect(screen.getByTestId('qty-li-2')).toHaveTextContent('1');
  });

  // ── ensureCartId idempotency (fix 2) ────────────────────────────────────────────────────────────

  it('two concurrent first-adds create exactly ONE cart (shared in-flight create promise)', async () => {
    let createCount = 0;
    request.mockImplementation((_m: string, path: string) => {
      if (path === '/store/v1/carts') {
        createCount += 1;
        return Promise.resolve({ cartId: 'cart-1', currency: 'EUR' });
      }
      if (path === '/store/v1/carts/{cartId}/items') return Promise.resolve(serverCart());
      return Promise.reject(new Error(`unexpected ${path}`));
    });

    function DoubleAddProbe() {
      const { addItem } = useCart();
      return (
        <button
          onClick={() => {
            void addItem('v1', 1).catch(() => {});
            void addItem('v2', 1).catch(() => {});
          }}
        >
          double-add
        </button>
      );
    }

    render(
      <CartProvider>
        <Probe />
        <DoubleAddProbe />
      </CartProvider>,
    );
    await act(async () => {
      screen.getByText('double-add').click();
    });
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('1'));
    // Exactly one POST /carts despite two concurrent first-adds.
    expect(createCount).toBe(1);
  });

  // ── Discount + remove coverage (fix 3) ──────────────────────────────────────────────────────────

  it('applyDiscount adopts the server discountTotal/grandTotal (never client-subtracted)', async () => {
    request.mockImplementation((_m: string, path: string) => {
      if (path === '/store/v1/carts') return Promise.resolve({ cartId: 'cart-1', currency: 'EUR' });
      if (path === '/store/v1/carts/{cartId}/items') return Promise.resolve(serverCart());
      if (path === '/store/v1/carts/{cartId}/discounts') {
        return Promise.resolve(
          serverCart({
            discountCode: 'SAVE10',
            totals: {
              subtotal: 1999,
              shipping: 0,
              discountTotal: 200,
              taxTotal: 0,
              grandTotal: 1799,
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
    await act(async () => {
      screen.getByText('add').click();
    });
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('1'));

    await act(async () => {
      screen.getByText('apply').click();
    });
    // discountTotal (200) and grandTotal (1799) are the SERVER's integer-minor-unit figures.
    await waitFor(() => expect(screen.getByTestId('discountTotal')).toHaveTextContent('200'));
    expect(screen.getByTestId('grand')).toHaveTextContent('1799');
    expect(screen.getByTestId('discountCode')).toHaveTextContent('SAVE10');
  });

  it('applyDiscount 422/ineligible throws and leaves the cart unchanged', async () => {
    request.mockImplementation((_m: string, path: string) => {
      if (path === '/store/v1/carts') return Promise.resolve({ cartId: 'cart-1', currency: 'EUR' });
      if (path === '/store/v1/carts/{cartId}/items') return Promise.resolve(serverCart());
      if (path === '/store/v1/carts/{cartId}/discounts') {
        return Promise.reject(new Error('discount ineligible (422)'));
      }
      return Promise.reject(new Error(`unexpected ${path}`));
    });

    render(
      <CartProvider>
        <Probe />
      </CartProvider>,
    );
    await act(async () => {
      screen.getByText('add').click();
    });
    await waitFor(() => expect(screen.getByTestId('grand')).toHaveTextContent('1999'));

    await act(async () => {
      screen.getByText('apply').click();
    });
    // Cart is unchanged — no discount applied, totals still the pre-apply server value.
    await waitFor(() => expect(screen.getByTestId('discountCode')).toHaveTextContent(''));
    expect(screen.getByTestId('discountTotal')).toHaveTextContent('0');
    expect(screen.getByTestId('grand')).toHaveTextContent('1999');
  });

  it('removeDiscount adopts the server cart with the discount cleared', async () => {
    request.mockImplementation((_m: string, path: string) => {
      if (path === '/store/v1/carts') return Promise.resolve({ cartId: 'cart-1', currency: 'EUR' });
      if (path === '/store/v1/carts/{cartId}/items') return Promise.resolve(serverCart());
      if (path === '/store/v1/carts/{cartId}/discounts') {
        return Promise.resolve(
          serverCart({
            discountCode: 'SAVE10',
            totals: {
              subtotal: 1999,
              shipping: 0,
              discountTotal: 200,
              taxTotal: 0,
              grandTotal: 1799,
              currency: 'EUR',
            },
          }),
        );
      }
      if (path === '/store/v1/carts/{cartId}/discounts/{code}') {
        return Promise.resolve(serverCart()); // discount cleared, back to grand 1999
      }
      return Promise.reject(new Error(`unexpected ${path}`));
    });

    render(
      <CartProvider>
        <Probe />
      </CartProvider>,
    );
    await act(async () => {
      screen.getByText('add').click();
    });
    await act(async () => {
      screen.getByText('apply').click();
    });
    await waitFor(() => expect(screen.getByTestId('discountCode')).toHaveTextContent('SAVE10'));

    await act(async () => {
      screen.getByText('removeDiscount').click();
    });
    await waitFor(() => expect(screen.getByTestId('discountCode')).toHaveTextContent(''));
    expect(screen.getByTestId('discountTotal')).toHaveTextContent('0');
    expect(screen.getByTestId('grand')).toHaveTextContent('1999');
  });

  it('removeItem adopts the authoritative cart returned by the delete', async () => {
    request.mockImplementation((_m: string, path: string) => {
      if (path === '/store/v1/carts') return Promise.resolve({ cartId: 'cart-1', currency: 'EUR' });
      if (path === '/store/v1/carts/{cartId}/items') return Promise.resolve(serverCart());
      if (path === '/store/v1/carts/{cartId}/items/{itemId}') {
        return Promise.resolve(
          serverCart({
            items: [],
            totals: {
              subtotal: 0,
              shipping: 0,
              discountTotal: 0,
              taxTotal: 0,
              grandTotal: 0,
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
    await act(async () => {
      screen.getByText('add').click();
    });
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('1'));

    await act(async () => {
      screen.getByText('remove').click();
    });
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('0'));
    expect(screen.getByTestId('grand')).toHaveTextContent('0');
  });
});
