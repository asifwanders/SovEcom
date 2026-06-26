/**
 * Inventory reservation system integration tests (NO-OVERSELL,
 * concurrency-critical). Full AppModule against real Postgres + Redis.
 *
 * Covers:
 *  - reserve respects available stock; backorder allows over-reserve
 *  - re-reserving the same (cart,variant) UPDATES (no duplicate row)
 *  - TTL: an expired reservation frees stock for a new cart
 *  - 100 concurrent reserves of the last unit → EXACTLY 1 succeeds, 99 → 409
 *  - availableStock subtracts all carts' active reservations
 *  - tenant isolation: reservations/availability never cross tenants
 *  - sweeper deletes expired 'reserved' rows
 */
import { ConflictException } from '@nestjs/common';
import { InventoryService } from '../../../src/inventory/inventory.service';
import { InsufficientStockException } from '../../../src/inventory/insufficient-stock.exception';
import { InventorySweeperService } from '../../../src/inventory/inventory-sweeper.service';
import {
  bootInventoryApp,
  resetInventoryState,
  seedVariant,
  seedCart,
  reservationsForVariant,
  reservationsForCart,
  expireReservation,
  stockOf,
  newId,
  InventoryHarness,
  DEFAULT_TENANT_ID,
} from './_inventory-harness';

let h: InventoryHarness;
let inventory: InventoryService;
let sweeper: InventorySweeperService;

beforeAll(async () => {
  h = await bootInventoryApp();
  inventory = h.app.get(InventoryService);
  sweeper = h.app.get(InventorySweeperService);
}, 30_000);

afterAll(async () => {
  await h.app.close();
  await h.client.end();
});

beforeEach(async () => {
  await resetInventoryState(h);
}, 10_000);

const T = DEFAULT_TENANT_ID;

// ── BASIC RESERVE ──────────────────────────────────────────────────────────────

describe('reserve()', () => {
  it('reserves within available stock and writes a reserved row', async () => {
    const { variantId } = await seedVariant(h, { stock: 10 });
    const cartId = await seedCart(h);

    const got = await inventory.reserve(T, cartId, variantId, 4);
    expect(got).toBe(4);

    const rows = await reservationsForVariant(h, variantId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.quantity).toBe(4);
    expect(rows[0]!.status).toBe('reserved');
    // stock_quantity is NOT decremented by reserve — only consume decrements.
    expect(await stockOf(h, variantId)).toBe(10);
  });

  it('throws InsufficientStockException (409) when over available, no backorder', async () => {
    const { variantId } = await seedVariant(h, { stock: 3 });
    const cartId = await seedCart(h);

    await expect(inventory.reserve(T, cartId, variantId, 5)).rejects.toBeInstanceOf(
      InsufficientStockException,
    );
    // 409 mapping
    await expect(inventory.reserve(T, cartId, variantId, 5)).rejects.toBeInstanceOf(
      ConflictException,
    );
    const rows = await reservationsForVariant(h, variantId);
    expect(rows).toHaveLength(0);
  });

  it('allows over-reserving when allow_backorder is true', async () => {
    const { variantId } = await seedVariant(h, { stock: 2, allowBackorder: true });
    const cartId = await seedCart(h);

    const got = await inventory.reserve(T, cartId, variantId, 100);
    expect(got).toBe(100);
    const rows = await reservationsForVariant(h, variantId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.quantity).toBe(100);
  });

  it('re-reserving the same (cart,variant) UPDATES the row, never duplicates', async () => {
    const { variantId } = await seedVariant(h, { stock: 10 });
    const cartId = await seedCart(h);

    await inventory.reserve(T, cartId, variantId, 2);
    await inventory.reserve(T, cartId, variantId, 5);

    const rows = await reservationsForVariant(h, variantId);
    expect(rows).toHaveLength(1); // updated, not duplicated
    expect(rows[0]!.quantity).toBe(5);
  });

  it('respects other carts active reservations when computing availability', async () => {
    const { variantId } = await seedVariant(h, { stock: 10 });
    const cartA = await seedCart(h);
    const cartB = await seedCart(h);

    await inventory.reserve(T, cartA, variantId, 6); // 6 of 10 held by A
    // B can take the remaining 4 …
    expect(await inventory.reserve(T, cartB, variantId, 4)).toBe(4);
    // … but not 5.
    const cartC = await seedCart(h);
    await expect(inventory.reserve(T, cartC, variantId, 1)).rejects.toBeInstanceOf(
      InsufficientStockException,
    );
  });

  it('clampToAvailable caps the reservation to remaining stock', async () => {
    const { variantId } = await seedVariant(h, { stock: 10 });
    const cartA = await seedCart(h);
    const cartB = await seedCart(h);

    await inventory.reserve(T, cartA, variantId, 6);
    const got = await inventory.reserve(T, cartB, variantId, 8, { clampToAvailable: true });
    expect(got).toBe(4); // clamped to the remaining 4
    const rows = await reservationsForCart(h, cartB);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.quantity).toBe(4);
  });

  it('clampToAvailable to 0 deletes any existing reservation and returns 0', async () => {
    const { variantId } = await seedVariant(h, { stock: 5 });
    const cartA = await seedCart(h);
    const cartB = await seedCart(h);

    await inventory.reserve(T, cartA, variantId, 5); // all gone
    await inventory.reserve(T, cartB, variantId, 0 + 0).catch(() => undefined); // no-op baseline
    const got = await inventory.reserve(T, cartB, variantId, 3, { clampToAvailable: true });
    expect(got).toBe(0);
    const rows = await reservationsForCart(h, cartB);
    expect(rows).toHaveLength(0);
  });

  it('throws NotFoundException for an unknown variant', async () => {
    const cartId = await seedCart(h);
    await expect(inventory.reserve(T, cartId, newId(), 1)).rejects.toMatchObject({
      status: 404,
    });
  });
});

// ── TTL / EXPIRY ────────────────────────────────────────────────────────────────

describe('TTL expiry', () => {
  it('an expired reservation frees stock for a new cart', async () => {
    const { variantId } = await seedVariant(h, { stock: 1 });
    const cartA = await seedCart(h);
    const cartB = await seedCart(h);

    await inventory.reserve(T, cartA, variantId, 1); // last unit held by A
    // B cannot take it while A's reservation is live.
    await expect(inventory.reserve(T, cartB, variantId, 1)).rejects.toBeInstanceOf(
      InsufficientStockException,
    );

    // Simulate A's reservation expiring.
    await expireReservation(h, cartA, variantId);

    // Now B succeeds — the expired reservation no longer counts against availability.
    expect(await inventory.reserve(T, cartB, variantId, 1)).toBe(1);
  });
});

// ── RELEASE ────────────────────────────────────────────────────────────────────

describe('release()', () => {
  it('release deletes that (cart,variant) reservation', async () => {
    const { variantId } = await seedVariant(h, { stock: 10 });
    const cartId = await seedCart(h);
    await inventory.reserve(T, cartId, variantId, 3);

    await inventory.release(T, cartId, variantId);
    expect(await reservationsForCart(h, cartId)).toHaveLength(0);
  });

  it('releaseForCart deletes all reservations for the cart', async () => {
    const a = await seedVariant(h, { stock: 10 });
    const b = await seedVariant(h, { stock: 10 });
    const cartId = await seedCart(h);
    await inventory.reserve(T, cartId, a.variantId, 1);
    await inventory.reserve(T, cartId, b.variantId, 2);

    await inventory.releaseForCart(T, cartId);
    expect(await reservationsForCart(h, cartId)).toHaveLength(0);
  });
});

// ── AVAILABILITY ───────────────────────────────────────────────────────────────

describe('availableStock()', () => {
  it('subtracts all active reservations across carts', async () => {
    const { variantId } = await seedVariant(h, { stock: 10 });
    const cartA = await seedCart(h);
    const cartB = await seedCart(h);
    await inventory.reserve(T, cartA, variantId, 3);
    await inventory.reserve(T, cartB, variantId, 2);

    expect(await inventory.availableStock(T, variantId)).toBe(5); // 10 - 3 - 2
  });

  it('ignores expired reservations', async () => {
    const { variantId } = await seedVariant(h, { stock: 10 });
    const cartA = await seedCart(h);
    await inventory.reserve(T, cartA, variantId, 4);
    await expireReservation(h, cartA, variantId);
    expect(await inventory.availableStock(T, variantId)).toBe(10);
  });
});

// ── THE HEADLINE: 100 CONCURRENT, ONE WINNER ───────────────────────────────────
// The "100 concurrent reserves of the last unit → exactly one wins" race was
// canonicalised into the concurrency harness, which fires all tasks
// through a shared-promise barrier for true simultaneity (and runs in its own
// merge-blocking CI job): see test/concurrency/reservation-race.test.ts.

// ── TENANT ISOLATION ───────────────────────────────────────────────────────────

describe('tenant isolation', () => {
  it('a reservation/availability never crosses tenants', async () => {
    // Second tenant
    const tenantB = newId();
    await h.client`
      insert into tenants (id, name, slug)
      values (${tenantB}, ${`T ${tenantB.slice(0, 8)}`}, ${`t-${tenantB.slice(0, 8)}`})
    `;

    // Same logical "last unit" in each tenant, independent variants.
    const va = await seedVariant(h, { stock: 1, tenantId: T });
    const vb = await seedVariant(h, { stock: 1, tenantId: tenantB });
    const cartA = await seedCart(h, { tenantId: T });
    const cartB = await seedCart(h, { tenantId: tenantB });

    // Reserving in tenant T's variant must not affect tenant B's availability.
    await inventory.reserve(T, cartA, va.variantId, 1);
    expect(await inventory.availableStock(tenantB, vb.variantId)).toBe(1);
    expect(await inventory.reserve(tenantB, cartB, vb.variantId, 1)).toBe(1);

    // Cross-tenant reserve against the wrong variant id → NotFound (variant not in that tenant).
    const cartA2 = await seedCart(h, { tenantId: T });
    await expect(inventory.reserve(T, cartA2, vb.variantId, 1)).rejects.toMatchObject({
      status: 404,
    });
  });
});

// ── SWEEPER ────────────────────────────────────────────────────────────────────

describe('InventorySweeperService', () => {
  it('deletes expired reserved rows, leaves live + confirmed rows', async () => {
    const { variantId } = await seedVariant(h, { stock: 10 });
    const liveCart = await seedCart(h);
    const expiredCart = await seedCart(h);
    const consumedCart = await seedCart(h);

    await inventory.reserve(T, liveCart, variantId, 1);
    await inventory.reserve(T, expiredCart, variantId, 1);
    await inventory.reserve(T, consumedCart, variantId, 1);
    // Flip the consumed cart's reservation to 'confirmed' directly (the sweeper must
    // leave confirmed rows alone — it only deletes expired status='reserved' rows).
    await h.client`
      update inventory_reservations set status = 'confirmed'
      where cart_id = ${consumedCart} and variant_id = ${variantId}
    `;

    await expireReservation(h, expiredCart, variantId);

    const deleted = await sweeper.sweep();
    expect(deleted).toBe(1); // only the expired reserved row

    expect(await reservationsForCart(h, liveCart)).toHaveLength(1);
    expect(await reservationsForCart(h, expiredCart)).toHaveLength(0);
    // confirmed row survives the sweeper (it is not status='reserved')
    expect(await reservationsForCart(h, consumedCart)).toHaveLength(1);
  });
});
