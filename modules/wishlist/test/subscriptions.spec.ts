/**
 * Unit tests — event subscriptions. The module subscribes to product.updated (signal) and, B2,
 * product.price_changed (drives the idempotent digest). Handlers are idempotent + payload-tolerant.
 */
import { describe, it, expect, vi } from 'vitest';
import type { EventsClient } from '@sovecom/module-sdk';
import { registerSubscriptions, type PriceDropDeps } from '../src/events/subscriptions';
import type { runPriceDropDigest } from '../src/digest/digest';

function fakeEvents(): {
  events: EventsClient;
  fire: (event: string, payload: unknown) => Promise<void>;
  subscribed: string[];
} {
  const handlers = new Map<string, (p: unknown) => void | Promise<void>>();
  const subscribed: string[] = [];
  const events: EventsClient = {
    on: (event, handler) => {
      handlers.set(event, handler);
      subscribed.push(event);
      return Promise.resolve();
    },
    emit: () => Promise.resolve(),
  };
  return {
    events,
    subscribed,
    fire: async (event, payload) => {
      const h = handlers.get(event);
      if (h) await h(payload);
    },
  };
}

describe('registerSubscriptions', () => {
  it('subscribes to product.updated', async () => {
    const { events, subscribed } = fakeEvents();
    await registerSubscriptions(events);
    expect(subscribed).toContain('product.updated');
  });

  it('invokes the hook with the productId from the payload', async () => {
    const { events, fire } = fakeEvents();
    const seen: string[] = [];
    await registerSubscriptions(events, { onProductUpdated: (id) => seen.push(id) });
    await fire('product.updated', { productId: 'p1' });
    expect(seen).toEqual(['p1']);
  });

  it('tolerates a malformed payload (no throw, no hook call)', async () => {
    const { events, fire } = fakeEvents();
    const seen: string[] = [];
    await registerSubscriptions(events, { onProductUpdated: (id) => seen.push(id) });
    await fire('product.updated', null);
    await fire('product.updated', { nope: true });
    await fire('product.updated', 'garbage');
    expect(seen).toEqual([]);
  });
});

// ── B2: product.price_changed drives the digest ──────────────────────────────

describe('registerSubscriptions — product.price_changed (B2)', () => {
  function depsWith(runDigest: typeof runPriceDropDigest): PriceDropDeps {
    return {
      runDigest,
      // `digest` (repo/email/settings) is opaque to the handler — it's forwarded to runDigest.
      digest: {} as PriceDropDeps['digest'],
    };
  }

  it('subscribes to product.price_changed when price-drop deps are provided', async () => {
    const { events, subscribed } = fakeEvents();
    await registerSubscriptions(events, { priceDrop: depsWith(vi.fn() as never) });
    expect(subscribed).toContain('product.price_changed');
  });

  it('does NOT subscribe to product.price_changed without deps', async () => {
    const { events, subscribed } = fakeEvents();
    await registerSubscriptions(events);
    expect(subscribed).not.toContain('product.price_changed');
  });

  it('runs the digest on a real DROP with a single candidate built from the event', async () => {
    const { events, fire } = fakeEvents();
    const runDigest = vi.fn().mockResolvedValue({ sent: 1, skipped: 0 });
    await registerSubscriptions(events, { priceDrop: depsWith(runDigest as never) });
    await fire('product.price_changed', {
      eventId: 'evt-abc',
      productId: 'p1',
      variantId: 'v1',
      oldPriceMinor: 2000,
      newPriceMinor: 1500,
      currency: 'EUR',
    });
    expect(runDigest).toHaveBeenCalledTimes(1);
    const [input] = runDigest.mock.calls[0];
    expect(input.candidates).toEqual([
      {
        productVariantId: 'v1',
        title: 'an item on your wishlist',
        oldPriceMinor: 2000,
        newPriceMinor: 1500,
        currency: 'EUR',
      },
    ]);
    // The run id is keyed on the core-assigned eventId → a redelivery of the SAME event dedupes.
    expect(input.digestRunId).toBe('price_changed:evt-abc');
  });

  it('does NOT run the digest on a price RISE (not a drop)', async () => {
    const { events, fire } = fakeEvents();
    const runDigest = vi.fn();
    await registerSubscriptions(events, { priceDrop: depsWith(runDigest as never) });
    await fire('product.price_changed', {
      eventId: 'evt-rise',
      productId: 'p1',
      variantId: 'v1',
      oldPriceMinor: 1500,
      newPriceMinor: 2000,
      currency: 'EUR',
    });
    expect(runDigest).not.toHaveBeenCalled();
  });

  it('tolerates a malformed price_changed payload (no throw, no run) — incl. missing eventId', async () => {
    const { events, fire } = fakeEvents();
    const runDigest = vi.fn();
    await registerSubscriptions(events, { priceDrop: depsWith(runDigest as never) });
    await fire('product.price_changed', null);
    await fire('product.price_changed', { variantId: 'v1' });
    await fire('product.price_changed', { variantId: 'v1', oldPriceMinor: 'x', newPriceMinor: 1 });
    // A well-formed DROP but with NO eventId is rejected (eventId is the required idempotency key).
    await fire('product.price_changed', {
      productId: 'p1',
      variantId: 'v1',
      oldPriceMinor: 2000,
      newPriceMinor: 1500,
      currency: 'EUR',
    });
    expect(runDigest).not.toHaveBeenCalled();
  });

  it('a redelivered SAME event (same eventId) produces the SAME run id (ledger dedupes)', async () => {
    const { events, fire } = fakeEvents();
    const runDigest = vi.fn().mockResolvedValue({ sent: 0, skipped: 1 });
    await registerSubscriptions(events, { priceDrop: depsWith(runDigest as never) });
    const drop = {
      eventId: 'evt-same',
      productId: 'p1',
      variantId: 'v1',
      oldPriceMinor: 2000,
      newPriceMinor: 1500,
      currency: 'EUR',
    };
    await fire('product.price_changed', drop);
    await fire('product.price_changed', drop);
    expect(runDigest).toHaveBeenCalledTimes(2);
    expect(runDigest.mock.calls[0][0].digestRunId).toBe(runDigest.mock.calls[1][0].digestRunId);
  });

  it('SF1: two DISTINCT drops of the SAME magnitude (flash-sale cycle) get DIFFERENT run ids', async () => {
    const { events, fire } = fakeEvents();
    const runDigest = vi.fn().mockResolvedValue({ sent: 1, skipped: 0 });
    await registerSubscriptions(events, { priceDrop: depsWith(runDigest as never) });
    // 100 → 70 twice (a sale cycle: 100→70 … back to 100 … 100→70 again). Same {old,new}, but each
    // is a genuinely distinct emit with its OWN eventId → must NOT be deduped as a redelivery.
    await fire('product.price_changed', {
      eventId: 'evt-cycle-1',
      productId: 'p1',
      variantId: 'v1',
      oldPriceMinor: 100,
      newPriceMinor: 70,
      currency: 'EUR',
    });
    await fire('product.price_changed', {
      eventId: 'evt-cycle-2',
      productId: 'p1',
      variantId: 'v1',
      oldPriceMinor: 100,
      newPriceMinor: 70,
      currency: 'EUR',
    });
    expect(runDigest).toHaveBeenCalledTimes(2);
    expect(runDigest.mock.calls[0][0].digestRunId).not.toBe(
      runDigest.mock.calls[1][0].digestRunId,
    );
  });
});
