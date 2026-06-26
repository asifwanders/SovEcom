'use client';

/**
 * Cart context — the client-side cart state for the transactional storefront.
 * MONEY-CRITICAL: every money figure rendered comes from the SERVER's authoritative totals; the
 * context never does cart arithmetic.
 *
 * Mechanism: each mutator calls the API via the credentialed browser-client (so the httpOnly
 * `sov_cart` cookie rides along) and then ADOPTS the cart the endpoint returns — which already carries
 * the recomputed `totals`. There is no separate "re-fetch" round-trip because the cart mutation
 * endpoints return the full serialized cart (see `CartController.serialize`); the response IS the
 * authoritative re-fetch. Add/quantity are OPTIMISTIC for snappy UI (item appears / qty bumps before
 * the response) and ROLL BACK on error; money totals are NEVER optimistic.
 *
 * Cart id: the create endpoint returns `{cartId,currency}` in the BODY (the id is not secret — the
 * cart TOKEN is, and that lives in the httpOnly `sov_cart` cookie the API sets/reads). So the context
 * tracks only the id; authorisation travels via the cookie + (for logged-in customers) the Bearer.
 *
 * API surface consumed (paths/bodies typed by client-js; the response view-types in `./cart-types` are
 * owned here, derived from `apps/api/src/cart` `CartController.serialize` + `CartTotals`).
 * Each mutator's `client.request<path, method, Response>(...)` call below documents its exact endpoint;
 * all return the full `CartView` (the authoritative re-fetch) except `POST /carts` -> `{cartId,currency}`
 * and `GET .../shipping-rates` -> `ShippingRateView[]`.
 *
 * Checkout mutators: `setEmail`, `setShippingAddress`/`setBillingAddress` (the REAL full address —
 * `setShippingAddress` UNCONDITIONALLY overwrites any prior placeholder), and `associateCustomer` (link
 * the logged-in customer so the server's tax engine sees their B2B/VAT context — reverse charge then
 * surfaces in the authoritative `totals.reverseCharge` flag, never a client inference).
 *
 * Shipping estimator: the API returns rates only once a destination COUNTRY is known, so
 * `estimateShipping` posts a minimal destination then GETs rates; `loadShippingRates` is the read-only
 * checkout variant (no address post). Totals/shipping costs are ALWAYS the server's minor-unit figures —
 * the context NEVER does money math. Reuses `formatPrice` etc. from `lib/api.ts` at the view layer —
 * integer minor units, never floats.
 */
import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { SovEcomClient } from '@sovecom/client-js';
import { createBrowserClient } from './browser-client';
import type {
  CartAddressInput,
  CartContextValue,
  CartView,
  CreateCartResponse,
  ShippingEstimateDestination,
  ShippingRateView,
} from './cart-types';

// View-types live in `./cart-types` (storefront-owned response shapes), extracted to keep this
// module under the 500-line rule. Importers pull types from `./cart-types` directly.

const CartContext = createContext<CartContextValue | null>(null);

function totalQuantity(cart: CartView | null): number {
  if (!cart) return 0;
  return cart.items.reduce((n, li) => n + li.quantity, 0);
}

export function CartProvider({
  children,
  getAccessToken,
}: {
  children: React.ReactNode;
  /** Optional live token getter so a logged-in customer's Bearer is attached (wired from auth-context). */
  getAccessToken?: () => string | null;
}): React.ReactElement {
  const [cart, setCart] = useState<CartView | null>(null);
  // Shipping rates from the most recent estimate (cart-page estimator). Display-only; the AUTHORITATIVE
  // totals/shipping cost still live on `cart.totals` (adopted from the server on every mutation).
  const [shippingRates, setShippingRates] = useState<ShippingRateView[] | null>(null);
  // A ref mirror of the latest cart, so a mutation can snapshot the pre-optimistic quantity WITHOUT
  // reading it inside a state-updater (which React StrictMode invokes twice — the second pass would
  // see the already-optimistic value and corrupt the snapshot). Updated in lockstep via `adopt`/
  // `patchCart` below; never read for rendering (that's `cart`).
  const cartRef = useRef<CartView | null>(null);
  // The cart id, also stashed in a ref so mutators that run back-to-back read the latest id without
  // waiting for a state flush.
  const cartIdRef = useRef<string | null>(null);
  // Memoizes an IN-FLIGHT `POST /carts` so two concurrent first-adds share ONE create (otherwise the
  // second create's `sov_cart` cookie clobbers the first → a silently-orphaned cart). Cleared on settle.
  const createPromiseRef = useRef<Promise<string> | null>(null);
  // Serializes mutations: each optimistic op chains off the previous one's settle, so only ONE
  // optimistic mutation is ever in flight. This prevents a stale rollback/snapshot from a later op
  // clobbering an earlier op's authoritative result (the lost-update class the review flagged).
  const mutationChainRef = useRef<Promise<unknown>>(Promise.resolve());

  const clientRef = useRef<SovEcomClient | null>(null);
  if (clientRef.current === null) {
    clientRef.current = createBrowserClient(getAccessToken ? { getAccessToken } : {});
  }
  const client = clientRef.current;

  const adopt = useCallback((next: CartView) => {
    cartIdRef.current = next.id;
    cartRef.current = next;
    setCart(next);
  }, []);

  /**
   * Apply a pure transform to the current cart, keeping the ref mirror and React state in lockstep.
   * Used for OPTIMISTIC line-qty changes and their per-line rollback — never for totals (those only
   * ever come from an authoritative server cart via `adopt`). The transform receives the latest cart
   * (from the ref, not a stale closure) and must be pure (StrictMode may invoke the inner updater
   * twice; the ref is set once, deterministically).
   */
  const patchCart = useCallback((transform: (c: CartView) => CartView) => {
    const current = cartRef.current;
    if (!current) return;
    const next = transform(current);
    cartRef.current = next;
    setCart(next);
  }, []);

  /**
   * Run `task` after any in-flight mutation settles, so optimistic ops never overlap. The chain
   * itself never rejects (each link's failure is isolated) — but the caller still gets the real
   * settlement of THEIR task (the returned promise rejects/resolves with the task's own outcome).
   */
  const enqueue = useCallback(<T,>(task: () => Promise<T>): Promise<T> => {
    const run = mutationChainRef.current.then(task, task);
    // Keep the chain alive regardless of this task's outcome (swallow on the chain copy only).
    mutationChainRef.current = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }, []);

  /**
   * Ensure a cart exists; returns its id (creating one via the body-returned `cartId` if needed).
   * Concurrent callers before the first create resolves share the SAME in-flight create promise.
   */
  const ensureCartId = useCallback(async (): Promise<string> => {
    if (cartIdRef.current) return cartIdRef.current;
    if (createPromiseRef.current) return createPromiseRef.current;
    const create = client
      .request<'/store/v1/carts', 'post', CreateCartResponse>('post', '/store/v1/carts', {
        body: {},
      })
      .then((res) => {
        cartIdRef.current = res.cartId;
        return res.cartId;
      })
      .finally(() => {
        createPromiseRef.current = null;
      });
    createPromiseRef.current = create;
    return create;
  }, [client]);

  const refresh = useCallback(async (): Promise<void> => {
    const id = cartIdRef.current;
    if (!id) return;
    const next = await client.request<'/store/v1/carts/{cartId}', 'get', CartView>(
      'get',
      '/store/v1/carts/{cartId}',
      { path: { cartId: id } },
    );
    adopt(next);
  }, [client, adopt]);

  const addItem = useCallback(
    (variantId: string, quantity: number): Promise<void> =>
      enqueue(async () => {
        const id = await ensureCartId();
        // Optimistic qty bump for an EXISTING line (count only — totals come from the server). The
        // prior qty is snapshotted from the ref (NOT inside a state-updater — StrictMode runs those
        // twice), so a rollback restores exactly this line to exactly its prior value.
        const existing = cartRef.current?.items.find((li) => li.variantId === variantId);
        const priorQty = existing?.quantity;
        if (priorQty !== undefined) {
          patchCart((c) => ({
            ...c,
            items: c.items.map((li) =>
              li.variantId === variantId ? { ...li, quantity: li.quantity + quantity } : li,
            ),
          }));
        }
        try {
          const next = await client.request<'/store/v1/carts/{cartId}/items', 'post', CartView>(
            'post',
            '/store/v1/carts/{cartId}/items',
            { path: { cartId: id }, body: { variantId, quantity } },
          );
          adopt(next); // authoritative cart + totals
        } catch (err) {
          if (priorQty !== undefined) {
            // Functional per-line restore — does NOT clobber any other line a concurrent op updated.
            patchCart((c) => ({
              ...c,
              items: c.items.map((li) =>
                li.variantId === variantId ? { ...li, quantity: priorQty } : li,
              ),
            }));
          }
          throw err;
        }
      }),
    [enqueue, client, ensureCartId, adopt, patchCart],
  );

  const updateItem = useCallback(
    (itemId: string, quantity: number): Promise<void> =>
      enqueue(async () => {
        const id = cartIdRef.current;
        if (!id) return;
        // Optimistic qty (count only — never totals). Snapshot the prior qty from the ref for an
        // isolated per-line rollback that won't overwrite a sibling line a concurrent op changed.
        const existing = cartRef.current?.items.find((li) => li.id === itemId);
        const priorQty = existing?.quantity;
        patchCart((c) => ({
          ...c,
          items: c.items.map((li) => (li.id === itemId ? { ...li, quantity } : li)),
        }));
        try {
          const next = await client.request<
            '/store/v1/carts/{cartId}/items/{itemId}',
            'patch',
            CartView
          >('patch', '/store/v1/carts/{cartId}/items/{itemId}', {
            path: { cartId: id, itemId },
            body: { quantity },
          });
          adopt(next);
        } catch (err) {
          if (priorQty !== undefined) {
            patchCart((c) => ({
              ...c,
              items: c.items.map((li) => (li.id === itemId ? { ...li, quantity: priorQty } : li)),
            }));
          }
          throw err;
        }
      }),
    [enqueue, client, adopt, patchCart],
  );

  const removeItem = useCallback(
    (itemId: string): Promise<void> =>
      enqueue(async () => {
        const id = cartIdRef.current;
        if (!id) return;
        const next = await client.request<
          '/store/v1/carts/{cartId}/items/{itemId}',
          'delete',
          CartView
        >('delete', '/store/v1/carts/{cartId}/items/{itemId}', { path: { cartId: id, itemId } });
        adopt(next);
      }),
    [enqueue, client, adopt],
  );

  const applyDiscount = useCallback(
    (code: string): Promise<void> =>
      enqueue(async () => {
        const id = await ensureCartId();
        const next = await client.request<'/store/v1/carts/{cartId}/discounts', 'post', CartView>(
          'post',
          '/store/v1/carts/{cartId}/discounts',
          { path: { cartId: id }, body: { code } },
        );
        adopt(next);
      }),
    [enqueue, client, ensureCartId, adopt],
  );

  const removeDiscount = useCallback(
    (code: string): Promise<void> =>
      enqueue(async () => {
        const id = cartIdRef.current;
        if (!id) return;
        const next = await client.request<
          '/store/v1/carts/{cartId}/discounts/{code}',
          'delete',
          CartView
        >('delete', '/store/v1/carts/{cartId}/discounts/{code}', { path: { cartId: id, code } });
        adopt(next);
      }),
    [enqueue, client, adopt],
  );

  const estimateShipping = useCallback(
    (destination: ShippingEstimateDestination): Promise<ShippingRateView[]> =>
      // Serialized like every other mutation (it mutates the server cart's address + recomputes totals).
      enqueue(async () => {
        const id = await ensureCartId();
        // SetAddressDto requires name/line1/city; an ESTIMATE only has the destination, so we send minimal
        // placeholders for the unused-by-shipping fields (zones/costs derive only from country + weight/subtotal).
        const next = await client.request<
          '/store/v1/carts/{cartId}/shipping-address',
          'post',
          CartView
        >('post', '/store/v1/carts/{cartId}/shipping-address', {
          path: { cartId: id },
          body: {
            name: '—',
            line1: '—',
            city: '—',
            postalCode: destination.postalCode,
            country: destination.country,
          },
        });
        adopt(next); // authoritative cart + recomputed totals for the new destination
        const rates = await client.request<
          '/store/v1/carts/{cartId}/shipping-rates',
          'get',
          ShippingRateView[]
        >('get', '/store/v1/carts/{cartId}/shipping-rates', { path: { cartId: id } });
        setShippingRates(rates);
        return rates;
      }),
    [enqueue, client, ensureCartId, adopt],
  );

  const loadShippingRates = useCallback(
    (): Promise<ShippingRateView[]> =>
      // READ-ONLY GET of rates for the cart's CURRENT (real) address — never posts an address, so it can't
      // clobber it with the estimator placeholder (the bug that clamped the flow back to the address step).
      enqueue(async () => {
        const id = cartIdRef.current ?? (await ensureCartId());
        const rates = await client.request<
          '/store/v1/carts/{cartId}/shipping-rates',
          'get',
          ShippingRateView[]
        >('get', '/store/v1/carts/{cartId}/shipping-rates', { path: { cartId: id } });
        setShippingRates(rates);
        return rates;
      }),
    [enqueue, client, ensureCartId],
  );

  const selectShippingRate = useCallback(
    (shippingRateId: string): Promise<void> =>
      enqueue(async () => {
        const id = cartIdRef.current;
        if (!id) return;
        const next = await client.request<
          '/store/v1/carts/{cartId}/shipping-method',
          'post',
          CartView
        >('post', '/store/v1/carts/{cartId}/shipping-method', {
          path: { cartId: id },
          body: { shippingRateId },
        });
        adopt(next); // server folds the chosen rate's cost into the authoritative totals
      }),
    [enqueue, client, adopt],
  );

  const setEmail = useCallback(
    (email: string): Promise<void> =>
      enqueue(async () => {
        const id = await ensureCartId();
        const next = await client.request<'/store/v1/carts/{cartId}/email', 'post', CartView>(
          'post',
          '/store/v1/carts/{cartId}/email',
          { path: { cartId: id }, body: { email } },
        );
        adopt(next);
      }),
    [enqueue, client, ensureCartId, adopt],
  );

  const setShippingAddress = useCallback(
    (address: CartAddressInput): Promise<void> =>
      // Post the REAL full address with NO guard — this unconditionally overwrites any prior
      // placeholder so none can persist to checkout/order. The server recomputes + we adopt totals.
      enqueue(async () => {
        const id = await ensureCartId();
        const next = await client.request<
          '/store/v1/carts/{cartId}/shipping-address',
          'post',
          CartView
        >('post', '/store/v1/carts/{cartId}/shipping-address', {
          path: { cartId: id },
          body: address,
        });
        adopt(next);
      }),
    [enqueue, client, ensureCartId, adopt],
  );

  const setBillingAddress = useCallback(
    (address: CartAddressInput): Promise<void> =>
      enqueue(async () => {
        const id = await ensureCartId();
        const next = await client.request<
          '/store/v1/carts/{cartId}/billing-address',
          'post',
          CartView
        >('post', '/store/v1/carts/{cartId}/billing-address', {
          path: { cartId: id },
          body: address,
        });
        adopt(next);
      }),
    [enqueue, client, ensureCartId, adopt],
  );

  const associateCustomer = useCallback(
    (): Promise<void> =>
      enqueue(async () => {
        const id = cartIdRef.current;
        if (!id) return;
        const next = await client.request<'/store/v1/carts/{cartId}/customer', 'post', CartView>(
          'post',
          '/store/v1/carts/{cartId}/customer',
          { path: { cartId: id } },
        );
        adopt(next);
      }),
    [enqueue, client, adopt],
  );

  const recomputeTotals = useCallback(
    (): Promise<void> =>
      // H1 fix: `GET /carts` (refresh) never recomputes tax, so after an in-checkout VAT change
      // totals go stale. Re-POST the cart's CURRENT address → server `recomputeCartTotals` reads the LIVE
      // customer VAT. No-op without a real address (no destination → tax 0). NO client tax math.
      enqueue(async () => {
        const id = cartIdRef.current;
        const address = cartRef.current?.shippingAddress;
        if (!id || !address) return;
        const next = await client.request<
          '/store/v1/carts/{cartId}/shipping-address',
          'post',
          CartView
        >('post', '/store/v1/carts/{cartId}/shipping-address', {
          path: { cartId: id },
          body: address as CartAddressInput,
        });
        adopt(next);
      }),
    [enqueue, client, adopt],
  );

  const value = useMemo<CartContextValue>(
    () => ({
      cart,
      itemCount: totalQuantity(cart),
      addItem,
      updateItem,
      removeItem,
      applyDiscount,
      removeDiscount,
      refresh,
      shippingRates,
      estimateShipping,
      loadShippingRates,
      selectShippingRate,
      setEmail,
      setShippingAddress,
      setBillingAddress,
      associateCustomer,
      recomputeTotals,
    }),
    [
      cart,
      addItem,
      updateItem,
      removeItem,
      applyDiscount,
      removeDiscount,
      refresh,
      shippingRates,
      estimateShipping,
      loadShippingRates,
      selectShippingRate,
      setEmail,
      setShippingAddress,
      setBillingAddress,
      associateCustomer,
      recomputeTotals,
    ],
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

/** Consume the cart context. Throws if used outside `<CartProvider>` (a wiring bug). */
export function useCart(): CartContextValue {
  const ctx = useContext(CartContext);
  if (ctx === null) {
    throw new Error('useCart must be used within a <CartProvider>');
  }
  return ctx;
}
