/**
 * guest-checkout recovery storage.
 *
 * The 409-swallow re-entry path must recover the REAL order NUMBER + token (never route a UUID as an
 * order number). These tests cover the cartId-keyed stash + recovery round trip and the honest-null
 * floor when the stash is gone. jsdom provides a real `sessionStorage`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  storeGuestCheckout,
  recoverGuestCheckout,
  storeGuestOrderToken,
  readGuestOrderToken,
} from './order-lookup';

beforeEach(() => {
  window.sessionStorage.clear();
});

describe('order-lookup — guest-checkout recovery (F1)', () => {
  it('stores by cart id and recovers the real order NUMBER + token (not a UUID)', () => {
    storeGuestCheckout('cart_1', 'SOV-1001', 'guest-tok-xyz');
    const ref = recoverGuestCheckout('cart_1');
    expect(ref).toEqual({ orderNumber: 'SOV-1001', token: 'guest-tok-xyz' });
    // The recovered orderNumber is the human order number, never the cart/order UUID.
    expect(ref?.orderNumber).not.toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('recovers null when nothing was stashed for the cart (honest fallback floor)', () => {
    expect(recoverGuestCheckout('unknown_cart')).toBeNull();
  });

  it('recovers null on a corrupt/partial stash rather than throwing', () => {
    window.sessionStorage.setItem('sov_order_checkout:cart_1', '{"orderNumber":"SOV-1"}'); // no token
    expect(recoverGuestCheckout('cart_1')).toBeNull();
    window.sessionStorage.setItem('sov_order_checkout:cart_2', 'not json');
    expect(recoverGuestCheckout('cart_2')).toBeNull();
  });

  it('keeps the order-number-keyed token index working (for the normal success path)', () => {
    storeGuestOrderToken('SOV-1001', 'guest-tok-xyz');
    expect(readGuestOrderToken('SOV-1001')).toBe('guest-tok-xyz');
    // A read for an un-stashed order is a clean null (CheckoutSuccess deliberately does NOT clear the
    // token — the one-time backend guest-order token is single-purpose + scope-limited, so leaving it in
    // sessionStorage for the duration of the tab is acceptable; there is no clear() on the surface).
    expect(readGuestOrderToken('SOV-9999')).toBeNull();
  });
});
