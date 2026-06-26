/**
 * guest order-token storage + order confirmation reads.
 *
 * The one-time guest `guestAccessToken` (returned ONCE by `/checkout`) must survive the trip to the
 * `/checkout/success` page. We stash it in `sessionStorage` keyed by order NUMBER — sessionStorage
 * (not localStorage) so it dies with the tab. SECURITY: never log it; never put it in a URL/query
 * (it would leak to history/Referer/server logs); the success page reads it from storage and sends it
 * in the `X-Order-Token` HEADER.
 *
 * A logged-in customer doesn't need the token — they read the order via their JWT (Bearer) at
 * `GET /store/v1/orders/{id}`. A guest reads `GET /store/v1/orders/by-number/{orderNumber}` with the
 * header. Both responses are the storefront-safe order view (`OrderView`).
 *
 * Browser-only: `sessionStorage` access is guarded so an accidental SSR import is a no-op, not a crash.
 */
import type { SovEcomClient } from '@sovecom/client-js';
import type { OrderView } from './payment-types';

const GUEST_TOKEN_PREFIX = 'sov_order_token:';
// A SECOND index, keyed by CART id, holding both the order number AND the token for THIS checkout. The
// payment-intent response returns only the order UUID (not the number), so on a 409-swallow re-entry
// (the order already existed) we must recover the real order NUMBER + token from here to drive the
// guest order lookup (`by-number/{orderNumber}` + X-Order-Token). Without it, a guest re-entering would
// be routed with a UUID-as-order-number their token can never satisfy (the F1 lockout). Same storage
// posture as the token: sessionStorage, never logged, never in a URL.
const GUEST_CHECKOUT_PREFIX = 'sov_order_checkout:';

function storageKey(orderNumber: string): string {
  return `${GUEST_TOKEN_PREFIX}${orderNumber}`;
}

function checkoutKey(cartId: string): string {
  return `${GUEST_CHECKOUT_PREFIX}${cartId}`;
}

/** What a successful guest `/checkout` yields and the confirmation page needs to read the order. */
export interface GuestCheckoutRef {
  orderNumber: string;
  token: string;
}

/** Stash the one-time guest order token under the order number (browser only; no-op on the server). */
export function storeGuestOrderToken(orderNumber: string, token: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(storageKey(orderNumber), token);
  } catch {
    // Storage may be unavailable (private mode / quota). The confirmation page degrades to a
    // "look up your order from your email" message rather than crashing.
  }
}

/** Read a stashed guest order token for an order number, or null if absent/unavailable. */
export function readGuestOrderToken(orderNumber: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage.getItem(storageKey(orderNumber));
  } catch {
    return null;
  }
}

/**
 * Stash the full guest-checkout reference (order NUMBER + token) under the CART id, in addition to the
 * order-number-keyed token. Called on a successful FIRST `/checkout` so a later 409-swallow re-entry for
 * the same cart can recover the real order number to read the order. Browser only; never logged.
 */
export function storeGuestCheckout(cartId: string, orderNumber: string, token: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(checkoutKey(cartId), JSON.stringify({ orderNumber, token }));
  } catch {
    /* storage unavailable — the confirmation page degrades to the honest fallback copy */
  }
}

/**
 * Recover the guest-checkout reference (order number + token) for a cart id, or null if it's gone
 * (cleared storage / a different tab). The 409-swallow re-entry path uses this so it NEVER routes a UUID
 * as an order number; when null, the caller falls back to the honest "check your email" floor.
 */
export function recoverGuestCheckout(cartId: string): GuestCheckoutRef | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(checkoutKey(cartId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<GuestCheckoutRef>;
    if (typeof parsed.orderNumber === 'string' && typeof parsed.token === 'string') {
      return { orderNumber: parsed.orderNumber, token: parsed.token };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Read an order for the confirmation page. Logged-in (a Bearer token is present on the client) →
 * `GET /store/v1/orders/{id}` by order id. Guest → `GET /store/v1/orders/by-number/{orderNumber}` with
 * the `X-Order-Token` header. The caller supplies whichever identifiers it has from checkout.
 */
export async function fetchOrderForConfirmation(
  client: SovEcomClient,
  params: { orderId?: string | null; orderNumber?: string | null; guestToken?: string | null },
  authenticated: boolean,
): Promise<OrderView> {
  if (authenticated && params.orderId) {
    return client.request<'/store/v1/orders/{id}', 'get', OrderView>(
      'get',
      '/store/v1/orders/{id}',
      { path: { id: params.orderId } },
    );
  }
  if (params.orderNumber && params.guestToken) {
    return client.request<'/store/v1/orders/by-number/{orderNumber}', 'get', OrderView>(
      'get',
      '/store/v1/orders/by-number/{orderNumber}',
      {
        path: { orderNumber: params.orderNumber },
        // The guest token rides in the HEADER, never the query string — no leak to logs.
        headers: { 'x-order-token': params.guestToken },
      },
    );
  }
  // Neither path is satisfiable (e.g. a guest whose token was lost). The caller shows a fallback.
  throw new Error('order-confirmation-unavailable');
}
