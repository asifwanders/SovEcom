/**
 * Unit tests — event subscriptions. The module subscribes to product.updated (signal) and, B2,
 * product.stock_changed (drives the idempotent restock notifier). Handlers are payload-tolerant.
 */
import { describe, it, expect, vi } from 'vitest';
import type { EventsClient } from '@sovecom/module-sdk';
import { registerSubscriptions, type RestockDeps } from '../src/events/subscriptions';
import type { runBackInStockNotifications } from '../src/notify/notify';

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

// ── B2: product.stock_changed drives the restock notifier ────────────────────

describe('registerSubscriptions — product.stock_changed (B2)', () => {
  function depsWith(runNotify: typeof runBackInStockNotifications): RestockDeps {
    return { runNotify, notify: {} as RestockDeps['notify'] };
  }

  it('subscribes to product.stock_changed when restock deps are provided', async () => {
    const { events, subscribed } = fakeEvents();
    await registerSubscriptions(events, { restock: depsWith(vi.fn() as never) });
    expect(subscribed).toContain('product.stock_changed');
  });

  it('does NOT subscribe to product.stock_changed without deps', async () => {
    const { events, subscribed } = fakeEvents();
    await registerSubscriptions(events);
    expect(subscribed).not.toContain('product.stock_changed');
  });

  it('runs the notifier for the variant on a back-IN-stock flip (available:true)', async () => {
    const { events, fire } = fakeEvents();
    const runNotify = vi.fn().mockResolvedValue({ sent: 1, skipped: 0, failed: 0 });
    await registerSubscriptions(events, { restock: depsWith(runNotify as never) });
    await fire('product.stock_changed', {
      eventId: 'evt-1',
      productId: 'p1',
      variantId: 'v1',
      available: true,
    });
    expect(runNotify).toHaveBeenCalledTimes(1);
    expect(runNotify.mock.calls[0][0]).toEqual({ restockedVariantIds: ['v1'] });
  });

  it('does NOT run the notifier on a depletion flip (available:false)', async () => {
    const { events, fire } = fakeEvents();
    const runNotify = vi.fn();
    await registerSubscriptions(events, { restock: depsWith(runNotify as never) });
    await fire('product.stock_changed', {
      eventId: 'evt-2',
      productId: 'p1',
      variantId: 'v1',
      available: false,
    });
    expect(runNotify).not.toHaveBeenCalled();
  });

  it('tolerates a malformed stock_changed payload (no throw, no run) — incl. missing eventId', async () => {
    const { events, fire } = fakeEvents();
    const runNotify = vi.fn();
    await registerSubscriptions(events, { restock: depsWith(runNotify as never) });
    await fire('product.stock_changed', null);
    await fire('product.stock_changed', { variantId: 'v1' });
    await fire('product.stock_changed', { eventId: 'e', variantId: 'v1', available: 'yes' });
    // A well-formed flip with NO eventId is rejected (eventId is a required contract field).
    await fire('product.stock_changed', { productId: 'p1', variantId: 'v1', available: true });
    expect(runNotify).not.toHaveBeenCalled();
  });

  it('re-running the same restock relies on the runner ledger (one-shot per subscription)', async () => {
    const { events, fire } = fakeEvents();
    const runNotify = vi.fn().mockResolvedValue({ sent: 0, skipped: 1, failed: 0 });
    await registerSubscriptions(events, { restock: depsWith(runNotify as never) });
    // Distinct eventIds (a genuinely separate restock signal), SAME variant — the notifier's
    // notified_at reservation (one-shot) makes the 2nd a no-op send regardless of eventId.
    await fire('product.stock_changed', { eventId: 'evt-a', productId: 'p1', variantId: 'v1', available: true });
    await fire('product.stock_changed', { eventId: 'evt-b', productId: 'p1', variantId: 'v1', available: true });
    expect(runNotify).toHaveBeenCalledTimes(2);
    expect(runNotify.mock.calls[0][0]).toEqual(runNotify.mock.calls[1][0]);
  });
});
