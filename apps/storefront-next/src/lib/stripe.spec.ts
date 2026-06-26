/**
 * `lib/stripe.ts` contract.
 *
 * Stripe.js is MOCKED (no real key, no network): we assert the memoized singleton + the graceful
 * missing-key path. The publishable key is read from the public env per call, so each test sets it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const loadStripeMock = vi.fn();
vi.mock('@stripe/stripe-js', () => ({
  loadStripe: (...args: unknown[]) => loadStripeMock(...args),
}));

import { getStripe, isStripeConfigured, __resetStripeForTests } from './stripe';

const ORIGINAL_KEY = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;

beforeEach(() => {
  loadStripeMock.mockReset().mockReturnValue(Promise.resolve({ id: 'stripe' }));
  __resetStripeForTests();
});

afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
  else process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = ORIGINAL_KEY;
});

describe('lib/stripe', () => {
  it('is configured + loads ONCE (memoized) when the publishable key is set', () => {
    process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = 'pk_test_123';
    expect(isStripeConfigured()).toBe(true);

    const p1 = getStripe();
    const p2 = getStripe();
    expect(p1).not.toBeNull();
    expect(p1).toBe(p2); // same memoized promise — not re-injected per call
    expect(loadStripeMock).toHaveBeenCalledTimes(1);
    expect(loadStripeMock).toHaveBeenCalledWith('pk_test_123');
  });

  it('returns null + reports unconfigured when the publishable key is absent (no crash)', () => {
    delete process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
    expect(isStripeConfigured()).toBe(false);
    expect(getStripe()).toBeNull();
    expect(loadStripeMock).not.toHaveBeenCalled();
  });

  it('treats a blank key as unconfigured (does not call loadStripe with an empty key)', () => {
    process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = '   ';
    expect(isStripeConfigured()).toBe(false);
    expect(getStripe()).toBeNull();
    expect(loadStripeMock).not.toHaveBeenCalled();
  });
});
