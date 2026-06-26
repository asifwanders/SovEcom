/**
 * Follow-up B2 — core EMISSION of the two observational commerce events (real Postgres, real app).
 *
 * Proves, against the real wired app + real PG, that:
 *   - a REAL variant price change (old !== new) emits `product.price_changed` with the correct
 *     old/new minor units + currency; a NO-OP price update emits nothing;
 *   - the admin variant-update stock path emits `product.stock_changed` ONLY on an availability FLIP
 *     across zero (0 → positive ⇒ available:true; positive → 0 ⇒ available:false); a non-flipping
 *     change (5 → 3) emits nothing; the payload carries NO stock quantity/level (boolean-only);
 *   - the ORDER-DECREMENT path (`InventoryService.consumeLineInTx`, run in a real tx) RETURNS the
 *     availability flip on depletion (positive → 0) and the RESTOCK path (`restockInTx`) returns the
 *     flip on 0 → positive — the seam the order/refund callers use to emit POST-COMMIT.
 *
 * Re-runnable against the PERSISTENT dev DB: every product/variant is namespaced by a per-run uuid
 * (RUN), so a second run never collides on slug/sku uniqueness. No raw control bytes anywhere.
 */
import { EventEmitter2 } from '@nestjs/event-emitter';

import {
  bootAuthApp,
  teardownAuthApp,
  AuthHarness,
  DEFAULT_TENANT_ID,
  newId,
} from '../auth/_auth-harness';
import { DatabaseService } from '../../../src/database/database.service';
import { VariantsService } from '../../../src/catalog/variants/variants.service';
import { InventoryService } from '../../../src/inventory/inventory.service';
import { ProductPriceChangedEvent } from '../../../src/catalog/events/product-price-changed.event';
import { ProductStockChangedEvent } from '../../../src/catalog/events/product-stock-changed.event';

const TENANT = DEFAULT_TENANT_ID;
const ACTOR = 'b2-actor';

describe('B2 core commerce-event emission (integration, real PG)', () => {
  let h: AuthHarness;
  let db: DatabaseService;
  let emitter: EventEmitter2;
  let variants: VariantsService;
  let inventory: InventoryService;

  const RUN = newId();

  /** Capture every event of `name` emitted on EventEmitter2 during `fn`, then detach. */
  async function capture<T>(name: string, fn: () => Promise<T>): Promise<{ result: T; events: unknown[] }> {
    const events: unknown[] = [];
    const handler = (e: unknown): void => {
      events.push(e);
    };
    emitter.on(name, handler);
    try {
      const result = await fn();
      // Let any synchronous @OnEvent fan-out settle.
      await new Promise((r) => setTimeout(r, 10));
      return { result, events };
    } finally {
      emitter.off(name, handler);
    }
  }

  /** Seed a published product + ONE variant with the given price/stock/backorder. Returns ids. */
  async function seedVariant(opts: {
    price?: number;
    stock?: number;
    allowBackorder?: boolean;
  }): Promise<{ productId: string; variantId: string }> {
    const productId = newId();
    const variantId = newId();
    const price = opts.price ?? 1000;
    const stock = opts.stock ?? 10;
    const allowBackorder = opts.allowBackorder ?? false;
    await h.client`
      insert into products (id, tenant_id, title, slug, status)
      values (${productId}, ${TENANT}, ${'B2 Product'}, ${`b2-${productId}`}, ${'draft'})
    `;
    await h.client`
      insert into product_variants
        (id, tenant_id, product_id, sku, title, options, price_amount, currency, stock_quantity, allow_backorder)
      values
        (${variantId}, ${TENANT}, ${productId}, ${`B2-${variantId}`}, ${'V'}, ${'{}'}::jsonb,
         ${price}, ${'EUR'}, ${stock}, ${allowBackorder})
    `;
    return { productId, variantId };
  }

  type Tx = Parameters<Parameters<DatabaseService['db']['transaction']>[0]>[0];
  const inTx = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => db.db.transaction(fn);

  beforeAll(async () => {
    h = await bootAuthApp();
    db = h.app.get(DatabaseService);
    emitter = h.app.get(EventEmitter2);
    variants = h.app.get(VariantsService);
    inventory = h.app.get(InventoryService);
    void RUN; // namespacing is via the per-seed uuid ids; RUN kept for parity with B1.
  });

  afterAll(async () => {
    await teardownAuthApp(h);
  });

  // ── price.changed ────────────────────────────────────────────────────────────

  it('a real price change emits product.price_changed with old/new minor units', async () => {
    const { productId, variantId } = await seedVariant({ price: 2000 });
    const { events } = await capture(ProductPriceChangedEvent.EVENT, () =>
      variants.update(TENANT, ACTOR, productId, variantId, { priceAmount: 1500 } as never),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      tenantId: TENANT,
      productId,
      variantId,
      oldPriceMinor: 2000,
      newPriceMinor: 1500,
      currency: 'EUR',
    });
    // SF1 — every emit carries a unique-per-emit eventId (the module idempotency key).
    expect(typeof (events[0] as { eventId: string }).eventId).toBe('string');
    expect((events[0] as { eventId: string }).eventId.length).toBeGreaterThan(0);
  });

  it('two SEPARATE price changes get DISTINCT eventIds (SF1 — no false dedup)', async () => {
    const { productId, variantId } = await seedVariant({ price: 100 });
    const first = await capture(ProductPriceChangedEvent.EVENT, () =>
      variants.update(TENANT, ACTOR, productId, variantId, { priceAmount: 70 } as never),
    );
    // Restore to 100, then drop to 70 AGAIN — same {old,new} magnitude, distinct real events.
    await variants.update(TENANT, ACTOR, productId, variantId, { priceAmount: 100 } as never);
    const second = await capture(ProductPriceChangedEvent.EVENT, () =>
      variants.update(TENANT, ACTOR, productId, variantId, { priceAmount: 70 } as never),
    );
    const id1 = (first.events[0] as { eventId: string }).eventId;
    const id2 = (second.events[0] as { eventId: string }).eventId;
    expect(id1).not.toBe(id2);
  });

  it('a NO-OP price update emits no product.price_changed', async () => {
    const { productId, variantId } = await seedVariant({ price: 2000 });
    const { events } = await capture(ProductPriceChangedEvent.EVENT, () =>
      variants.update(TENANT, ACTOR, productId, variantId, { priceAmount: 2000 } as never),
    );
    expect(events).toHaveLength(0);
  });

  // ── stock.changed via the admin variant-update path ───────────────────────────

  it('admin stock 0 → positive emits product.stock_changed{available:true} (boolean only)', async () => {
    const { productId, variantId } = await seedVariant({ stock: 0 });
    const { events } = await capture(ProductStockChangedEvent.EVENT, () =>
      variants.update(TENANT, ACTOR, productId, variantId, { stockQuantity: 5 } as never),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ tenantId: TENANT, productId, variantId, available: true });
    // The competitive-info guard: the event NEVER carries a stock level / quantity.
    expect(events[0]).not.toHaveProperty('stockQuantity');
    expect(events[0]).not.toHaveProperty('quantity');
  });

  it('admin stock positive → 0 emits product.stock_changed{available:false}', async () => {
    const { productId, variantId } = await seedVariant({ stock: 4 });
    const { events } = await capture(ProductStockChangedEvent.EVENT, () =>
      variants.update(TENANT, ACTOR, productId, variantId, { stockQuantity: 0 } as never),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ available: false });
  });

  it('admin stock change that does NOT cross zero (5 → 3) emits nothing', async () => {
    const { productId, variantId } = await seedVariant({ stock: 5 });
    const { events } = await capture(ProductStockChangedEvent.EVENT, () =>
      variants.update(TENANT, ACTOR, productId, variantId, { stockQuantity: 3 } as never),
    );
    expect(events).toHaveLength(0);
  });

  // ── stock flip seam on the ORDER/REFUND inventory path (returned to the caller) ─

  it('consumeLineInTx returns a positive → 0 flip (available:false) and decrements stock', async () => {
    const cartId = newId();
    await h.client`
      insert into carts (id, tenant_id, session_token, currency, status, expires_at)
      values (${cartId}, ${TENANT}, ${newId()}, ${'EUR'}, ${'active'}, ${new Date(Date.now() + 86400000).toISOString()})
    `;
    const { productId, variantId } = await seedVariant({ stock: 2 });
    const flip = await inTx((tx) => inventory.consumeLineInTx(tx, TENANT, cartId, variantId, 2));
    expect(flip).toEqual({ variantId, productId, available: false });
    const rows = await h.client<{ stock_quantity: number }[]>`
      select stock_quantity from product_variants where id = ${variantId}
    `;
    expect(Number(rows[0]!.stock_quantity)).toBe(0);
  });

  it('consumeLineInTx that does NOT deplete to zero returns null (no flip)', async () => {
    const cartId = newId();
    await h.client`
      insert into carts (id, tenant_id, session_token, currency, status, expires_at)
      values (${cartId}, ${TENANT}, ${newId()}, ${'EUR'}, ${'active'}, ${new Date(Date.now() + 86400000).toISOString()})
    `;
    const { variantId } = await seedVariant({ stock: 5 });
    const flip = await inTx((tx) => inventory.consumeLineInTx(tx, TENANT, cartId, variantId, 2));
    expect(flip).toBeNull();
  });

  it('restockInTx returns a 0 → positive flip (available:true) and increments stock', async () => {
    const { productId, variantId } = await seedVariant({ stock: 0 });
    const flip = await inTx((tx) => inventory.restockInTx(tx, TENANT, variantId, 3));
    expect(flip).toEqual({ variantId, productId, available: true });
    const rows = await h.client<{ stock_quantity: number }[]>`
      select stock_quantity from product_variants where id = ${variantId}
    `;
    expect(Number(rows[0]!.stock_quantity)).toBe(3);
  });

  it('restockInTx onto already-positive stock returns null (no flip)', async () => {
    const { variantId } = await seedVariant({ stock: 5 });
    const flip = await inTx((tx) => inventory.restockInTx(tx, TENANT, variantId, 3));
    expect(flip).toBeNull();
  });
});
