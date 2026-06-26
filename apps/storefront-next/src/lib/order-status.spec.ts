/**
 * unit tests for `orderHasInvoice`.
 *
 * An invoice/receipt is issued on the `order.paid` event, so it exists for `paid` and every status
 * beyond it (including refunds — the original invoice persists), and NOT for `pending_payment` or
 * `cancelled`. This drives the visibility of the storefront invoice-download affordance, so the
 * boundary (cancelled/unpaid → hidden) is asserted explicitly.
 */
import { describe, it, expect } from 'vitest';
import { orderHasInvoice, orderIsReturnable, STATUS_KEYS } from './order-status';

describe('orderHasInvoice', () => {
  it('is true for paid and every status beyond it', () => {
    for (const status of [
      'paid',
      'fulfilled',
      'shipped',
      'delivered',
      'completed',
      'refunded',
      'partially_refunded',
    ]) {
      expect(orderHasInvoice(status), status).toBe(true);
    }
  });

  it('is false for pending_payment and cancelled (never paid → no invoice)', () => {
    expect(orderHasInvoice('pending_payment')).toBe(false);
    expect(orderHasInvoice('cancelled')).toBe(false);
  });

  it('is false for an unknown/unexpected status string', () => {
    expect(orderHasInvoice('totally_unknown')).toBe(false);
    expect(orderHasInvoice('')).toBe(false);
  });

  it('classifies every canonical status (no enum value left unhandled)', () => {
    // Guards against a future STATUS_KEYS addition silently defaulting to "no invoice".
    for (const status of STATUS_KEYS) {
      expect(typeof orderHasInvoice(status)).toBe('boolean');
    }
  });
});

describe('orderIsReturnable', () => {
  it('is true for the five returnable statuses (paid through partially_refunded)', () => {
    for (const status of ['paid', 'fulfilled', 'shipped', 'delivered', 'partially_refunded']) {
      expect(orderIsReturnable(status), status).toBe(true);
    }
  });

  it('is false for pending_payment, completed, cancelled and refunded', () => {
    for (const status of ['pending_payment', 'completed', 'cancelled', 'refunded']) {
      expect(orderIsReturnable(status), status).toBe(false);
    }
  });

  it('is false for an unknown/unexpected status string', () => {
    expect(orderIsReturnable('totally_unknown')).toBe(false);
    expect(orderIsReturnable('')).toBe(false);
  });

  it('classifies every canonical status (no enum value left unhandled)', () => {
    for (const status of STATUS_KEYS) {
      expect(typeof orderIsReturnable(status)).toBe('boolean');
    }
  });
});
