/**
 * reviews — purchase-gate seam unit tests (B1). The gap is now CLOSED via the gated `read:orders`
 * commerce probe (`sdk.commerce.hasPurchased`). Locks the wired behavior:
 *   - the default verifier delegates to the REAL commerce probe (purchaser → true, non-buyer → false);
 *   - the gate genuinely CONSULTS `sdk.commerce` (the read:orders grant is exercised);
 *   - a throwing probe degrades to DENY (an unprovable purchase is never a pass);
 *   - the seam stays injectable so a test can pin a deterministic verdict.
 */
import { describe, it, expect } from 'vitest';
import {
  hasPurchased,
  commercePurchaseVerifier,
  denyUnverifiablePurchaseVerifier,
  type PurchaseVerifier,
} from '../src/purchase/purchase-gate';
import { FakeCommerce } from './_mock-sdk';

describe('hasPurchased seam (B1, commerce-backed)', () => {
  it('default verifier returns the commerce probe verdict: a real purchaser → true', async () => {
    const commerce = new FakeCommerce((c, p) => c === 'cust-1' && p === 'prod-1');
    expect(await hasPurchased(commerce, 'cust-1', 'prod-1')).toBe(true);
  });

  it('default verifier: a non-purchaser → false', async () => {
    const commerce = new FakeCommerce(() => false);
    expect(await hasPurchased(commerce, 'cust-1', 'prod-1')).toBe(false);
  });

  it('genuinely consults the read:orders commerce surface (the grant is used, not just declared)', async () => {
    const commerce = new FakeCommerce(() => true);
    await hasPurchased(commerce, 'cust-1', 'prod-1');
    expect(commerce.calls).toEqual([{ customerId: 'cust-1', productId: 'prod-1' }]);
  });

  it('a throwing commerce probe degrades to DENY (no signal != purchased)', async () => {
    const commerce = new FakeCommerce(() => true, new Error('forbidden'));
    expect(await hasPurchased(commerce, 'cust-1', 'prod-1')).toBe(false);
  });

  it('empty ids → false without even consulting the probe', async () => {
    const commerce = new FakeCommerce(() => true);
    expect(await hasPurchased(commerce, '', 'prod-1')).toBe(false);
    expect(await hasPurchased(commerce, 'cust-1', '')).toBe(false);
    expect(commerce.calls).toHaveLength(0);
  });

  it('an injected verifier overrides the verdict (the stub seam for tests)', async () => {
    const commerce = new FakeCommerce(() => false); // probe would deny…
    const allow: PurchaseVerifier = { verify: () => Promise.resolve(true) }; // …but the stub allows
    expect(await hasPurchased(commerce, 'cust-1', 'prod-1', allow)).toBe(true);
  });

  it('commercePurchaseVerifier returns the probe verdict', async () => {
    const commerce = new FakeCommerce(() => true);
    expect(
      await commercePurchaseVerifier.verify({
        customerId: 'c',
        productId: 'p',
        commerce,
      }),
    ).toBe(true);
  });

  it('denyUnverifiablePurchaseVerifier still always returns false (retained fallback)', async () => {
    const commerce = new FakeCommerce(() => true);
    expect(
      await denyUnverifiablePurchaseVerifier.verify({
        customerId: 'c',
        productId: 'p',
        commerce,
      }),
    ).toBe(false);
  });
});
