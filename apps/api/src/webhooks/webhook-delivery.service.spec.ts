/**
 * Webhook delivery lease invariant.
 *
 * The lease a claimed row holds MUST strictly exceed the worst-case time one drain spends
 * on a full batch (CLAIM_LIMIT deliveries × per-delivery timeout). If it were shorter, a
 * lease could expire while the first instance is still delivering, letting a second instance
 * re-claim the same row and double-deliver (the in-memory `running` guard is per-process,
 * and recordResult updates by id with no ownership check).
 */
import { leaseMs, deliveryTimeoutMs, WEBHOOK_CLAIM_LIMIT } from './webhook-delivery.service';

describe('webhook delivery lease invariant', () => {
  const ORIGINAL = process.env.WEBHOOK_DELIVERY_TIMEOUT_MS;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.WEBHOOK_DELIVERY_TIMEOUT_MS;
    else process.env.WEBHOOK_DELIVERY_TIMEOUT_MS = ORIGINAL;
  });

  it('leaseMs() strictly exceeds CLAIM_LIMIT * deliveryTimeoutMs() at the default timeout', () => {
    delete process.env.WEBHOOK_DELIVERY_TIMEOUT_MS;
    expect(leaseMs()).toBeGreaterThan(WEBHOOK_CLAIM_LIMIT * deliveryTimeoutMs());
  });

  it('holds the invariant even at a large configured timeout', () => {
    process.env.WEBHOOK_DELIVERY_TIMEOUT_MS = '30000';
    expect(leaseMs()).toBeGreaterThan(WEBHOOK_CLAIM_LIMIT * deliveryTimeoutMs());
  });
});
