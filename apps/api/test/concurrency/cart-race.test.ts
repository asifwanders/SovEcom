/**
 * Cart race — concurrency control.
 *
 * (1) N concurrent add-item of DIFFERENT variants to ONE cart → all N survive.
 *     Before the WATCH/retry atomicity fix this FAILS: every mutation is
 *     load(full blob)→mutate→SETEX(full blob) with no concurrency control, so
 *     concurrent adds last-write-wins and all but one variant are lost. After the
 *     fix the optimistic loop replays the loser, so every variant lands.
 * (2) Concurrent updates to the SAME item → final state consistent; the stored
 *     quantity equals the reservation, totals match the surviving quantity.
 */
import {
  bootConcurrencyApp,
  teardownConcurrencyApp,
  resetConcurrencyState,
  seedVariant,
  seedVariants,
  runConcurrently,
  DEFAULT_TENANT_ID,
  type ConcurrencyHarness,
} from './harness';

let h: ConcurrencyHarness;
const T = DEFAULT_TENANT_ID;

beforeAll(async () => {
  h = await bootConcurrencyApp();
}, 60_000);

afterAll(async () => {
  await teardownConcurrencyApp(h);
});

beforeEach(async () => {
  await resetConcurrencyState(h);
}, 20_000);

describe('Cart race — no data loss', () => {
  it('N concurrent adds of DIFFERENT variants to one cart → all N survive', async () => {
    const N = 10;
    const { variantIds } = await seedVariants(h, N, { stock: 50 });

    // One cart, created through the service so it has a session token + Redis blob.
    const cart = await h.cart.create(T);
    const token = cart.sessionToken;

    const { fulfilled, rejected } = await runConcurrently(
      N,
      (i) => h.cart.addItem(T, cart.id, token, undefined, variantIds[i]!, 1),
      'add distinct variants to one cart',
    );

    // No add should be rejected outright (each variant has ample stock).
    expect(rejected).toHaveLength(0);
    expect(fulfilled).toHaveLength(N);

    // The authoritative final state must contain ALL N distinct variants — the
    // core no-data-loss assertion. (Pre-fix: only ~1 survives.)
    const finalCart = await h.cart.findByIdAuthorised(T, cart.id, token, undefined);
    const gotVariants = new Set(finalCart.items.map((it) => it.variantId));
    expect(finalCart.items).toHaveLength(N);
    for (const v of variantIds) {
      expect(gotVariants.has(v)).toBe(true);
    }

    // Reservations must match: exactly one reserved row per variant for this cart.
    const reservations = await h.client<{ variant_id: string; quantity: number }[]>`
      select variant_id, quantity from inventory_reservations
      where cart_id = ${cart.id} and status = 'reserved'
    `;
    expect(reservations).toHaveLength(N);
    expect(reservations.every((r) => r.quantity === 1)).toBe(true);

    // Totals reflect every surviving line (N variants × qty 1 × 1000 minor units).
    expect(finalCart.totals.subtotal).toBe(N * 1000);
  }, 60_000);

  it('concurrent updates to the SAME item → final qty == reservation, totals consistent', async () => {
    const { variantId } = await seedVariant(h, { stock: 100, priceAmount: 1000 });
    const cart = await h.cart.create(T);
    const token = cart.sessionToken;

    // One line to update.
    const withItem = await h.cart.addItem(T, cart.id, token, undefined, variantId, 1);
    const itemId = withItem.items[0]!.id;

    // 12 concurrent updates to distinct quantities. Whichever lands last wins, but
    // the stored quantity MUST equal the surviving reservation and the totals.
    const quantities = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];
    const { fulfilled } = await runConcurrently(
      quantities.length,
      (i) => h.cart.updateItem(T, cart.id, itemId, token, undefined, quantities[i]!),
      'concurrent same-item updates',
    );
    expect(fulfilled.length).toBeGreaterThan(0);

    const finalCart = await h.cart.findByIdAuthorised(T, cart.id, token, undefined);
    expect(finalCart.items).toHaveLength(1);
    const finalQty = finalCart.items[0]!.quantity;
    expect(quantities).toContain(finalQty);

    // The reservation for this (cart,variant) must equal the cart's final qty —
    // no double-counting, no orphaned over-reservation (reserve is idempotent).
    const reservations = await h.client<{ quantity: number }[]>`
      select quantity from inventory_reservations
      where cart_id = ${cart.id} and variant_id = ${variantId} and status = 'reserved'
    `;
    expect(reservations).toHaveLength(1);
    expect(reservations[0]!.quantity).toBe(finalQty);

    // Totals match the surviving quantity.
    expect(finalCart.totals.subtotal).toBe(finalQty * 1000);
  }, 60_000);

  it('concurrent adds of the SAME variant collapse to one line summing quantities', async () => {
    const { variantId } = await seedVariant(h, { stock: 100, priceAmount: 1000 });
    const cart = await h.cart.create(T);
    const token = cart.sessionToken;

    const N = 8;
    const { rejected } = await runConcurrently(
      N,
      () => h.cart.addItem(T, cart.id, token, undefined, variantId, 1),
      'concurrent same-variant adds',
    );
    expect(rejected).toHaveLength(0);

    const finalCart = await h.cart.findByIdAuthorised(T, cart.id, token, undefined);
    // One line, quantity == N (each +1 merged atomically).
    expect(finalCart.items).toHaveLength(1);
    expect(finalCart.items[0]!.quantity).toBe(N);

    const reservations = await h.client<{ quantity: number }[]>`
      select quantity from inventory_reservations
      where cart_id = ${cart.id} and variant_id = ${variantId} and status = 'reserved'
    `;
    expect(reservations).toHaveLength(1);
    expect(reservations[0]!.quantity).toBe(N);
    expect(finalCart.totals.subtotal).toBe(N * 1000);
  }, 60_000);
});
