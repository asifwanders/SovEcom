/**
 * Follow-up B1 — widened broker READ surface end-to-end (real Postgres, real broker over RPC).
 *
 * Proves the two new least-privilege read seams against real data through the actual
 * BrokerReadAdapter + ModuleBroker + worker SDK (an in-memory RPC pair, the established pattern):
 *
 *   1. `ModuleProductDto.category` — a product's PRIMARY category (lowest position, id-tiebroken) is
 *      populated from `product_categories`/`categories` on `products.get`/`list`; a product with no
 *      category omits it. Rides the EXISTING `read:products` grant.
 *   2. `commerce.hasPurchased(customerId, productId)` — gated by `read:orders` (FORBIDDEN without it),
 *      tenant-scoped from ctx, returns ONLY a boolean: true for a paid order containing the product,
 *      false for a non-buyer / non-purchased product / a pending(unpaid) order, and a DIFFERENT
 *      tenant's identical order never counts.
 */
import { eq } from 'drizzle-orm';

import {
  bootAuthApp,
  teardownAuthApp,
  AuthHarness,
  DEFAULT_TENANT_ID,
  newId,
} from '../auth/_auth-harness';
import { DatabaseService } from '../../../src/database/database.service';
import { products } from '../../../src/database/schema/products';
import { categories } from '../../../src/database/schema/categories';
import { productCategories } from '../../../src/database/schema/product_categories';
import { productVariants } from '../../../src/database/schema/product_variants';
import { orders } from '../../../src/database/schema/orders';
import { orderItems } from '../../../src/database/schema/order_items';
import { customers } from '../../../src/database/schema/customers';
import { tenants } from '../../../src/database/schema/_tenants';
import { RpcPeer } from '../../../src/modules/runtime/rpc';
import { RpcErrorCode } from '../../../src/modules/runtime/ipc-protocol';
import { createInMemoryChannelPair } from '../../../src/modules/runtime/worker-channel';
import { createModuleSdk } from '../../../src/modules/runtime/worker-sdk';
import { ModuleBroker, type BrokerContext } from '../../../src/modules/runtime/module-broker';
import type { ModulePermission } from '../../../src/modules/module-manifest';
import { BrokerReadAdapter } from '../../../src/modules/runtime/broker-read.adapter';
import type { ModuleSdk } from '@sovecom/module-sdk';

const TENANT = DEFAULT_TENANT_ID;
const MOD = 'b1-read-surface';

interface Wired {
  sdk: ModuleSdk;
  dispose: () => void;
}

/** A paid order for `customerId` containing `productId` (via a variant). Returns the order id. */
async function seedPaidOrder(
  db: DatabaseService,
  tenantId: string,
  customerId: string,
  variantId: string,
  status: 'pending_payment' | 'paid' | 'fulfilled' | 'refunded' | 'cancelled' = 'paid',
): Promise<string> {
  const [order] = await db.db
    .insert(orders)
    .values({
      tenantId,
      orderNumber: `B1-${newId()}`,
      customerId,
      email: 'buyer@example.com',
      status,
      currency: 'EUR',
      subtotalAmount: 1000,
      totalAmount: 1000,
      taxInclusive: true,
      shippingAddress: {},
      billingAddress: {},
    })
    .returning({ id: orders.id });
  await db.db.insert(orderItems).values({
    tenantId,
    orderId: order!.id,
    variantId,
    productTitle: 'Bought thing',
    sku: `sku-${newId()}`,
    quantity: 1,
    unitPriceAmount: 1000,
    taxRate: '0.2000',
    taxAmount: 0,
    lineTotalAmount: 1000,
  });
  return order!.id;
}

describe('B1 widened broker read surface (integration, real PG)', () => {
  let h: AuthHarness;
  let db: DatabaseService;
  let adapter: BrokerReadAdapter;

  // Seeded ids reused across tests.
  let productWithCat: string; // has a primary category
  let productNoCat: string; // has none
  let variantOfWithCat: string; // a variant of productWithCat
  let categoryId: string;
  let primarySlug: string; // the primary category's (unique-per-run) slug, asserted on
  let buyer: string; // a customer who bought productWithCat
  let nonBuyer: string; // a customer who bought nothing

  // A unique suffix per run so the suite is re-runnable against the PERSISTENT dev DB with zero
  // leftover-data collisions (slugs/SKUs/emails are all namespaced by it). The dev DB is never reset
  // between runs, so fixed slugs would hit products_tenant_slug_uq on the second run. Use the FULL
  // uuidv7 (NOT a truncated prefix — its first hex chars are a slowly-changing ms-timestamp prefix
  // that two runs seconds apart can share).
  const RUN = newId();

  beforeAll(async () => {
    h = await bootAuthApp();
    db = h.app.get(DatabaseService);
    adapter = new BrokerReadAdapter(db);

    // Two products: one with a category, one without (unique slugs per run).
    [productWithCat, productNoCat] = await Promise.all(
      [`b1-with-cat-${RUN}`, `b1-no-cat-${RUN}`].map(async (slug) => {
        const [row] = await db.db
          .insert(products)
          .values({ tenantId: TENANT, title: `B1 ${slug}`, slug, status: 'published' })
          .returning({ id: products.id });
        return row!.id;
      }),
    );

    // A category + the M2M link (only for productWithCat). position 5 so a second, higher-position
    // link can prove "lowest position wins".
    primarySlug = `b1-primary-${RUN}`;
    const [cat] = await db.db
      .insert(categories)
      .values({ tenantId: TENANT, name: 'Primary Cat', slug: primarySlug, position: 5 })
      .returning({ id: categories.id });
    categoryId = cat!.id;
    const [cat2] = await db.db
      .insert(categories)
      .values({ tenantId: TENANT, name: 'Secondary Cat', slug: `b1-secondary-${RUN}`, position: 9 })
      .returning({ id: categories.id });
    await db.db.insert(productCategories).values([
      { tenantId: TENANT, productId: productWithCat, categoryId: categoryId },
      { tenantId: TENANT, productId: productWithCat, categoryId: cat2!.id },
    ]);

    // A variant of productWithCat so an order line can map back to the product.
    const [variant] = await db.db
      .insert(productVariants)
      .values({
        tenantId: TENANT,
        productId: productWithCat,
        sku: `b1-var-${RUN}`,
        options: {},
        priceAmount: 1000,
        currency: 'EUR',
      })
      .returning({ id: productVariants.id });
    variantOfWithCat = variant!.id;

    // Two customers (unique emails per run).
    [buyer, nonBuyer] = await Promise.all(
      ['b1-buyer', 'b1-nonbuyer'].map(async (tag) => {
        const [row] = await db.db
          .insert(customers)
          .values({ tenantId: TENANT, email: `${tag}-${RUN}@example.com` })
          .returning({ id: customers.id });
        return row!.id;
      }),
    );

    // The buyer has a PAID order containing the variant (→ productWithCat).
    await seedPaidOrder(db, TENANT, buyer, variantOfWithCat, 'paid');
  });

  afterAll(async () => {
    await teardownAuthApp(h);
  });

  // ── 1. category DTO field ────────────────────────────────────────────────────

  it('products.get populates the PRIMARY category (lowest position, id-tiebroken)', async () => {
    const dto = await adapter.products.get(TENANT, productWithCat);
    expect(dto).not.toBeNull();
    expect(dto!.category).toEqual({ id: categoryId, slug: primarySlug, name: 'Primary Cat' });
  });

  it('products.get omits category for a product that has none', async () => {
    const dto = await adapter.products.get(TENANT, productNoCat);
    expect(dto).not.toBeNull();
    expect(dto!.category).toBeUndefined();
  });

  it('products.list populates category per row (batched, no N+1 leak of others)', async () => {
    // The persistent dev DB may hold many products; our freshly-inserted rows have the highest
    // (uuidv7, time-ordered) ids, so page forward until we have collected both of ours.
    let withCat: { category?: { slug: string } } | undefined;
    let noCat: { category?: unknown } | undefined;
    let cursor: string | undefined;
    for (let i = 0; i < 50 && (!withCat || !noCat); i += 1) {
      const res = await adapter.products.list(TENANT, {
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      withCat ??= res.items.find((p) => p.id === productWithCat);
      noCat ??= res.items.find((p) => p.id === productNoCat);
      if (!res.nextCursor) break;
      cursor = res.nextCursor;
    }
    expect(withCat?.category).toMatchObject({ slug: primarySlug });
    expect(noCat).toBeDefined();
    expect(noCat!.category).toBeUndefined();
  });

  // ── 2. commerce.hasPurchased over the real broker + worker SDK ────────────────

  function wire(grants: ModulePermission[]): Wired {
    const broker = new ModuleBroker(
      adapter,
      { fetch: () => Promise.reject(new Error('no egress')) } as never,
      { exec: () => Promise.reject(new Error('no executor')) } as never,
      { subscribe() {}, emitModuleEvent() {}, unsubscribe() {} } as never,
      { send: () => Promise.reject(new Error('no mail')) } as never,
    );
    const [core, worker] = createInMemoryChannelPair();
    const corePeer = new RpcPeer(core, { requestTimeoutMs: 5000 });
    const workerPeer = new RpcPeer(worker, { requestTimeoutMs: 5000 });
    const ctx: BrokerContext = {
      tenantId: TENANT,
      moduleName: MOD,
      grantedPermissions: new Set<ModulePermission>(grants),
      httpAllowlist: new Set<string>(),
    };
    broker.registerOn(corePeer, ctx);
    return {
      sdk: createModuleSdk(workerPeer),
      dispose: () => {
        corePeer.dispose();
        workerPeer.dispose();
      },
    };
  }

  it('FORBIDDEN without read:orders (the permission gate)', async () => {
    const env = wire(['read:products']);
    try {
      await expect(env.sdk.commerce.hasPurchased(buyer, productWithCat)).rejects.toMatchObject({
        code: RpcErrorCode.FORBIDDEN,
      });
    } finally {
      env.dispose();
    }
  });

  it('true for a customer with a paid order containing the product', async () => {
    const env = wire(['read:orders']);
    try {
      await expect(env.sdk.commerce.hasPurchased(buyer, productWithCat)).resolves.toBe(true);
    } finally {
      env.dispose();
    }
  });

  it('false for a non-buyer, and for a product the buyer never bought', async () => {
    const env = wire(['read:orders']);
    try {
      await expect(env.sdk.commerce.hasPurchased(nonBuyer, productWithCat)).resolves.toBe(false);
      await expect(env.sdk.commerce.hasPurchased(buyer, productNoCat)).resolves.toBe(false);
    } finally {
      env.dispose();
    }
  });

  it('a PENDING (unpaid) order does not count as a purchase', async () => {
    // A fresh customer whose only order is pending_payment.
    const [pendingCust] = await db.db
      .insert(customers)
      .values({ tenantId: TENANT, email: `b1-pending-${newId()}@example.com` })
      .returning({ id: customers.id });
    await seedPaidOrder(db, TENANT, pendingCust!.id, variantOfWithCat, 'pending_payment');
    const env = wire(['read:orders']);
    try {
      await expect(env.sdk.commerce.hasPurchased(pendingCust!.id, productWithCat)).resolves.toBe(
        false,
      );
    } finally {
      env.dispose();
    }
  });

  it('tenant-scoped: another tenant with an identical paid order never counts', async () => {
    // Stand up a second tenant with its OWN product/variant/customer + a paid order, then ask the
    // DEFAULT-tenant broker about that tenant's customer/product — it must be false (no cross-tenant).
    const [tenantB] = await db.db
      .insert(tenants)
      .values({ name: 'B1 Tenant B', slug: `b1-tenant-b-${newId()}` })
      .returning({ id: tenants.id });
    const [pB] = await db.db
      .insert(products)
      .values({ tenantId: tenantB!.id, title: 'B prod', slug: 'b1-b-prod', status: 'published' })
      .returning({ id: products.id });
    const [vB] = await db.db
      .insert(productVariants)
      .values({
        tenantId: tenantB!.id,
        productId: pB!.id,
        sku: `b1-bvar-${newId()}`,
        options: {},
        priceAmount: 1000,
        currency: 'EUR',
      })
      .returning({ id: productVariants.id });
    const [cB] = await db.db
      .insert(customers)
      .values({ tenantId: tenantB!.id, email: `b1-bcust-${newId()}@example.com` })
      .returning({ id: customers.id });
    await seedPaidOrder(db, tenantB!.id, cB!.id, vB!.id, 'paid');

    const env = wire(['read:orders']); // ctx tenant is the DEFAULT tenant, NOT tenantB
    try {
      // tenant-B's real buyer + product, asked of the default-tenant broker → false.
      await expect(env.sdk.commerce.hasPurchased(cB!.id, pB!.id)).resolves.toBe(false);
    } finally {
      env.dispose();
    }

    // Sanity: a broker bound to tenant B DOES see it (proves the data is real, only scope differs);
    // the DEFAULT tenant must NOT see tenant B's order.
    expect(await adapter.commerce.hasPurchased(tenantB!.id, cB!.id, pB!.id)).toBe(true);
    expect(await adapter.commerce.hasPurchased(TENANT, cB!.id, pB!.id)).toBe(false);

    // Clean up tenant B (cascades its products/variants/customers/orders).
    await db.db.delete(tenants).where(eq(tenants.id, tenantB!.id));
  });
});
