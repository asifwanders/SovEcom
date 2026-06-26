/**
 * Reservation race — stock availability under concurrency.
 *
 * Canonical home for the "100 concurrent reserves of the LAST unit → exactly 1
 * wins" test (moved from the 2.3 inventory int-spec). Uses the harness'
 * shared-promise barrier so all 100 reserves genuinely start at once and race
 * the Postgres `FOR UPDATE` lock. The lock must serialise them into exactly one
 * winner; the other 99 must get a 409 InsufficientStock, never a deadlock or
 * other error, and the DB must end with exactly one reserved row.
 */
import { InsufficientStockException } from '../../src/inventory/insufficient-stock.exception';
import {
  bootConcurrencyApp,
  teardownConcurrencyApp,
  resetConcurrencyState,
  seedVariant,
  seedCart,
  runConcurrently,
  newId,
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

async function reservedRowsForVariant(variantId: string): Promise<{ quantity: number }[]> {
  return h.client<{ quantity: number }[]>`
    select quantity from inventory_reservations
    where variant_id = ${variantId} and status = 'reserved'
  `;
}

describe('Reservation race — no oversell', () => {
  it('100 concurrent reserves of the LAST unit → exactly 1 succeeds, 99 get 409', async () => {
    const { variantId } = await seedVariant(h, { stock: 1 });

    // Distinct carts seeded in Postgres first so reservations can FK to them.
    const cartIds = await Promise.all(Array.from({ length: 100 }, () => seedCart(h)));

    const { fulfilled, rejected } = await runConcurrently(
      100,
      (i) => h.inventory.reserve(T, cartIds[i]!, variantId, 1),
      'reserve last unit',
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(99);
    // Every rejection is the 409 InsufficientStock — never a deadlock/other error.
    for (const r of rejected) {
      expect(r.reason).toBeInstanceOf(InsufficientStockException);
    }

    // The DB holds exactly one reserved row, for exactly 1 unit.
    const rows = await reservedRowsForVariant(variantId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.quantity).toBe(1);

    // Availability is honoured: the held unit is gone.
    expect(await h.inventory.availableStock(T, variantId)).toBe(0);
    // stock_quantity is NOT decremented by reserve (only consume decrements).
    const stock = await h.client<{ stock_quantity: number }[]>`
      select stock_quantity from product_variants where id = ${variantId}
    `;
    expect(Number(stock[0]!.stock_quantity)).toBe(1);
  }, 60_000);

  it('reserves of 5 available units by 20 carts → exactly 5 winners, 15 get 409', async () => {
    const { variantId } = await seedVariant(h, { stock: 5 });
    const cartIds = await Promise.all(Array.from({ length: 20 }, () => seedCart(h)));

    const { fulfilled, rejected } = await runConcurrently(
      20,
      (i) => h.inventory.reserve(T, cartIds[i]!, variantId, 1),
      'reserve 5 of 5',
    );

    expect(fulfilled).toHaveLength(5);
    expect(rejected).toHaveLength(15);
    for (const r of rejected) {
      expect(r.reason).toBeInstanceOf(InsufficientStockException);
    }
    expect(await h.inventory.availableStock(T, variantId)).toBe(0);
    const rows = await reservedRowsForVariant(variantId);
    expect(rows).toHaveLength(5);
    expect(rows.reduce((s, r) => s + r.quantity, 0)).toBe(5);
  }, 60_000);

  it('an unknown variant under load → all reject with 404 (no phantom rows)', async () => {
    const cartIds = await Promise.all(Array.from({ length: 10 }, () => seedCart(h)));
    const bogus = newId();
    const { fulfilled, rejected } = await runConcurrently(
      10,
      (i) => h.inventory.reserve(T, cartIds[i]!, bogus, 1),
      'reserve unknown variant',
    );
    expect(fulfilled).toHaveLength(0);
    expect(rejected).toHaveLength(10);
  }, 60_000);
});
