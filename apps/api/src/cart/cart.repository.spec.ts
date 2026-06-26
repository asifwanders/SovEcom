/**
 *hardening — terminal-conflict reservation compensation.
 *
 * When the optimistic mutate() loop exhausts its retry budget, the LAST reserve() the mutator
 * ran already committed to Postgres against the LAST-READ (pre-mutation) Redis blob, but that
 * blob was never written back → an orphan reservation can count against other carts until TTL.
 * mutate() must invoke the compensation callback with that last-read state before throwing 409,
 * so the caller can reconcile PG reservations to the authoritative cart. On success it must NOT.
 */
import { CartRepository } from './cart.repository';
import { CartConflictException } from './cart-conflict.exception';
import type { RedisService } from '../redis/redis.service';
import type { DatabaseService } from '../database/database.service';
import type { CartWatchPool } from './cart-watch-pool';
import type { CartState } from './cart.types';

function makeCartBlob(): CartState {
  const now = new Date('2026-01-01T00:00:00.000Z');
  return {
    id: 'cart-1',
    tenantId: 't1',
    customerId: null,
    sessionToken: 'tok',
    currency: 'EUR',
    status: 'active',
    guestEmail: null,
    items: [
      {
        id: 'i1',
        variantId: 'v1',
        quantity: 3,
        unitPriceAmount: 1000,
        currency: 'EUR',
        productTitle: 'Product 1',
        variantTitle: null,
        options: {},
        sku: 'SKU-v1',
        productSlug: 'product-1',
        createdAt: now,
        updatedAt: now,
      },
    ],
    shippingAddress: null,
    billingAddress: null,
    shippingRateId: null,
    shippingAmount: 0,
    discountCode: null,
    totals: {
      subtotal: 3000,
      shipping: 0,
      discountTotal: 0,
      taxTotal: 0,
      grandTotal: 3000,
      currency: 'EUR',
    },
    expiresAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

/** A mock pooled connection whose EXEC behaviour is configurable (null = WATCH abort). */
function makeConn(blob: CartState, execResult: () => [Error | null, unknown][] | null) {
  const multi = {
    setex: jest.fn().mockReturnThis(),
    sadd: jest.fn().mockReturnThis(),
    exec: jest.fn(async () => execResult()),
  };
  return {
    watch: jest.fn().mockResolvedValue('OK'),
    unwatch: jest.fn().mockResolvedValue('OK'),
    get: jest.fn().mockResolvedValue(JSON.stringify(blob)),
    multi: jest.fn(() => multi),
  };
}

function makeRepo(conn: ReturnType<typeof makeConn>) {
  const redis = { client: {} } as unknown as RedisService;
  const db = {} as DatabaseService;
  const watchPool = {
    acquire: jest.fn().mockResolvedValue({ conn, transient: false }),
    release: jest.fn().mockResolvedValue(undefined),
  } as unknown as CartWatchPool;
  return new CartRepository(redis, db, watchPool);
}

describe('CartRepository.mutate() —terminal-conflict compensation', () => {
  it('invokes compensate with the LAST-READ state, then throws CartConflictException', async () => {
    const blob = makeCartBlob();
    // EXEC always aborts (null) → the retry budget is exhausted → terminal conflict.
    const conn = makeConn(blob, () => null);
    const repo = makeRepo(conn);

    const compensate = jest.fn().mockResolvedValue(undefined);
    let mutatorRuns = 0;

    await expect(
      repo.mutate(
        't1',
        'cart-1',
        (state) => {
          mutatorRuns++;
          // Simulate a mutation that diverges PG from the committed blob.
          if (state) state.items[0]!.quantity = 99;
          return state;
        },
        compensate,
      ),
    ).rejects.toBeInstanceOf(CartConflictException);

    // Compensation fired exactly once, with the PRE-mutation (last-read) items (qty 3, not 99).
    expect(compensate).toHaveBeenCalledTimes(1);
    const passed = compensate.mock.calls[0]![0] as CartState;
    expect(passed.items).toHaveLength(1);
    expect(passed.items[0]!.variantId).toBe('v1');
    expect(passed.items[0]!.quantity).toBe(3); // authoritative last-read qty, NOT the mutated 99
    // The loop did retry (livelock), not give up on the first attempt.
    expect(mutatorRuns).toBeGreaterThan(1);
  });

  it('does NOT invoke compensate when the mutation commits successfully', async () => {
    const blob = makeCartBlob();
    // EXEC succeeds (non-null, no per-command error).
    const conn = makeConn(blob, () => [[null, 'OK']]);
    const repo = makeRepo(conn);

    const compensate = jest.fn().mockResolvedValue(undefined);
    await repo.mutate('t1', 'cart-1', (state) => state, compensate);

    expect(compensate).not.toHaveBeenCalled();
  });
});
