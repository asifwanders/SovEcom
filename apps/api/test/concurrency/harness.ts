/**
 * Reusable concurrency test harness.
 *
 * Boots the full AppModule against real Postgres + Redis and provides:
 *  - seed helpers (pinned tenant, published product + variant with a stock level,
 *    customer signup+login, cart create),
 *  - a SHARED-PROMISE BARRIER so N async tasks truly start at the same instant
 *    rather than being staggered by their own setup — the only way to provoke a real race,
 *  - timing metrics (p50/p95/p99) logged per run,
 *  - a reset helper that clears the carts / cart_items / inventory_reservations /
 *    products / variants tables between tests.
 *
 * The boot reuses the cart harness' AppModule wiring (VIES stub, pinned tenant,
 * Redis flush) so behaviour matches the rest of the integration suite exactly.
 */
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ZodValidationPipe } from 'nestjs-zod';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import postgres from 'postgres';
import { drizzle, PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import Redis from 'ioredis';
import { uuidv7 } from 'uuidv7';
import { randomUUID } from 'node:crypto';
import * as schema from '../../src/database/schema';
import { AppModule } from '../../src/app.module';
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter';
import { StoreTenantService } from '../../src/catalog/store-tenant.service';
import { RedisService } from '../../src/redis/redis.service';
import { CartService } from '../../src/cart/cart.service';
import { CartRepository } from '../../src/cart/cart.repository';
import { InventoryService } from '../../src/inventory/inventory.service';
import { OrderService } from '../../src/orders/orders.service';
import {
  VIES_CLIENT,
  type ViesClient,
  type ViesCheckResult,
} from '../../src/customers/vies/vies.client';

const MIGRATIONS = 'src/database/migrations';
export const DEFAULT_TENANT_ID = '01900000-0000-7000-8000-000000000000';

export const newId = (): string => uuidv7();
export const uniqEmail = (): string =>
  `conc-test-${Date.now()}-${Math.random().toString(36).slice(2)}@test.invalid`;

/** Stub ViesClient — no network egress in tests. */
class StubViesClient implements ViesClient {
  async check(_countryCode: string, _vatNumber: string): Promise<ViesCheckResult> {
    return { valid: false, name: null, address: null };
  }
}

export interface ConcurrencyHarness {
  app: INestApplication;
  client: ReturnType<typeof postgres>;
  db: PostgresJsDatabase<typeof schema>;
  redis: Redis;
  cart: CartService;
  cartRepo: CartRepository;
  inventory: InventoryService;
  orders: OrderService;
  http(): Express.Application;
}

export async function bootConcurrencyApp(): Promise<ConcurrencyHarness> {
  const client = postgres(process.env.DATABASE_URL as string, { max: 1 });
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(VIES_CLIENT)
    .useValue(new StubViesClient())
    .compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>();
  app.useGlobalPipes(new ZodValidationPipe());
  app.useGlobalFilters(new AllExceptionsFilter());
  app.use(cookieParser());
  await app.init();

  const redisService = app.get(RedisService);
  await redisService.ping();
  const redis = redisService.client;
  await redis.flushdb();

  const storeTenant = app.get(StoreTenantService, { strict: false }) as unknown as {
    defaultTenantId: string | null;
  };
  storeTenant.defaultTenantId = DEFAULT_TENANT_ID;

  return {
    app,
    client,
    db,
    redis,
    cart: app.get(CartService),
    cartRepo: app.get(CartRepository),
    inventory: app.get(InventoryService),
    orders: app.get(OrderService),
    http: () => app.getHttpServer(),
  };
}

export async function teardownConcurrencyApp(h: ConcurrencyHarness): Promise<void> {
  await h.app.close();
  await h.client.end();
}

/**
 * Reset all per-test state: truncate commerce + catalog + customer tables
 * (CASCADE covers cart_items / inventory_reservations), flush Redis, and re-seed
 * the pinned tenant + the system_state row StoreTenantService resolves against.
 */
export async function resetConcurrencyState(h: ConcurrencyHarness): Promise<void> {
  await h.client.unsafe(`
    TRUNCATE TABLE
      invoices, invoice_counters,
      discount_usages, discounts,
      order_status_history, order_items, orders, order_counters,
      inventory_reservations, cart_items, carts,
      product_tags, product_categories, product_images, bundle_items,
      product_variants, products, categories, tags,
      customer_addresses, customers,
      audit_log, refresh_tokens, password_reset_tokens,
      shipping_rates, shipping_zones,
      users
    RESTART IDENTITY CASCADE
  `);
  await h.redis.flushdb();

  const existing = await h.client<{ id: string }[]>`
    select id from tenants where id = ${DEFAULT_TENANT_ID}
  `;
  if (existing.length === 0) {
    await h.client`
      insert into tenants (id, name, slug) values (${DEFAULT_TENANT_ID}, ${'Test Tenant'}, ${'test'})
    `;
  }
  await h.client`
    insert into system_state (key, value)
    values ('default_tenant_id', to_jsonb(${DEFAULT_TENANT_ID}::text))
    on conflict (key) do update set value = excluded.value, updated_at = now()
  `;
}

/** Seed a published product + ONE variant with the given stock / backorder flag. */
export async function seedVariant(
  h: ConcurrencyHarness,
  opts: {
    stock?: number;
    allowBackorder?: boolean;
    tenantId?: string;
    currency?: string;
    priceAmount?: number;
  } = {},
): Promise<{ productId: string; variantId: string; currency: string }> {
  const tenantId = opts.tenantId ?? DEFAULT_TENANT_ID;
  const stock = opts.stock ?? 10;
  const allowBackorder = opts.allowBackorder ?? false;
  const currency = opts.currency ?? 'EUR';
  const priceAmount = opts.priceAmount ?? 1000;
  const productId = newId();
  const variantId = newId();

  // Full ids in slug/sku: uuidv7's first hex chars are a ms timestamp, so two
  // seeds in the same millisecond would collide on a truncated slug.
  await h.client`
    insert into products (id, tenant_id, title, slug, status)
    values (${productId}, ${tenantId}, ${'Conc Product'}, ${`conc-${productId}`}, ${'published'})
  `;
  await h.client`
    insert into product_variants
      (id, tenant_id, product_id, sku, title, options, price_amount, currency, stock_quantity, allow_backorder)
    values
      (${variantId}, ${tenantId}, ${productId}, ${`CONC-${variantId}`}, ${'V'}, ${'{}'}::jsonb,
       ${priceAmount}, ${currency}, ${stock}, ${allowBackorder})
  `;
  return { productId, variantId, currency };
}

/**
 * Seed N published variants on ONE product (distinct variants for the cart-race
 * "add different variants" test). Returns their ids.
 */
export async function seedVariants(
  h: ConcurrencyHarness,
  count: number,
  opts: { stock?: number; currency?: string } = {},
): Promise<{ productId: string; variantIds: string[]; currency: string }> {
  const tenantId = DEFAULT_TENANT_ID;
  const stock = opts.stock ?? 100;
  const currency = opts.currency ?? 'EUR';
  const productId = newId();
  await h.client`
    insert into products (id, tenant_id, title, slug, status)
    values (${productId}, ${tenantId}, ${'Conc Product'}, ${`conc-${productId}`}, ${'published'})
  `;
  const variantIds: string[] = [];
  for (let i = 0; i < count; i++) {
    const variantId = newId();
    await h.client`
      insert into product_variants
        (id, tenant_id, product_id, sku, title, options, price_amount, currency, stock_quantity, allow_backorder)
      values
        (${variantId}, ${tenantId}, ${productId}, ${`CONC-${variantId}`}, ${`V${i}`}, ${'{}'}::jsonb,
         ${1000}, ${currency}, ${stock}, ${false})
    `;
    variantIds.push(variantId);
  }
  return { productId, variantIds, currency };
}

/** Insert an empty cart row directly in Postgres so reservations can FK to it. */
export async function seedCart(
  h: ConcurrencyHarness,
  opts: { tenantId?: string; currency?: string } = {},
): Promise<string> {
  const tenantId = opts.tenantId ?? DEFAULT_TENANT_ID;
  const currency = opts.currency ?? 'EUR';
  const cartId = newId();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  await h.client`
    insert into carts (id, tenant_id, session_token, currency, status, expires_at)
    values (${cartId}, ${tenantId}, ${randomUUID()}, ${currency}, ${'active'}, ${expiresAt})
  `;
  return cartId;
}

/** Signup + login a customer; returns ids + access token. */
export async function signupAndLoginCustomer(
  h: ConcurrencyHarness,
  overrides: { email?: string; password?: string } = {},
): Promise<{ customerId: string; email: string; accessToken: string }> {
  const email = overrides.email ?? uniqEmail();
  const password = overrides.password ?? 'correct horse battery staple';

  const signup = await request(h.http())
    .post('/store/v1/customers')
    .send({ email, password, name: 'Conc Test Customer' });
  if (signup.status !== 201) {
    throw new Error(`signup failed: ${signup.status} ${JSON.stringify(signup.body)}`);
  }
  const customerId = signup.body.id as string;

  const login = await request(h.http()).post('/store/v1/customers/login').send({ email, password });
  if (login.status !== 200) {
    throw new Error(`login failed: ${login.status} ${JSON.stringify(login.body)}`);
  }
  return { customerId, email, accessToken: login.body.accessToken as string };
}

// ── Shared-promise barrier ─────────────────────────────────────────────────────

/**
 * A one-shot gate that N tasks await; calling `release()` resolves them all in
 * the same microtask flush, so they proceed together (true simultaneity).
 */
export class Barrier {
  private resolveFn!: () => void;
  readonly gate: Promise<void>;
  constructor() {
    this.gate = new Promise<void>((resolve) => {
      this.resolveFn = resolve;
    });
  }
  release(): void {
    this.resolveFn();
  }
}

export interface ConcurrentResult<T> {
  results: PromiseSettledResult<T>[];
  fulfilled: PromiseFulfilledResult<T>[];
  rejected: PromiseRejectedResult[];
  /** Per-task durations in ms (in completion order), and p50/p95/p99. */
  timings: { durationsMs: number[]; p50: number; p95: number; p99: number };
}

/**
 * Build N tasks, have each await a shared barrier, release the barrier so they
 * race, then `Promise.allSettled` them. Captures per-op timings and logs
 * p50/p95/p99 timing metrics.
 *
 * @param n      number of concurrent tasks
 * @param taskFn (i) => Promise<T>; receives the task index
 * @param label  printed with the timing line
 */
export async function runConcurrently<T>(
  n: number,
  taskFn: (i: number) => Promise<T>,
  label = 'concurrent op',
): Promise<ConcurrentResult<T>> {
  const barrier = new Barrier();
  const durationsMs: number[] = [];

  const tasks = Array.from({ length: n }, (_unused, i) =>
    (async (): Promise<T> => {
      // Gate FIRST: every task is parked here before any does real work, so the
      // release fires them in one batch rather than staggered by their build.
      await barrier.gate;
      const start = performance.now();
      try {
        return await taskFn(i);
      } finally {
        durationsMs.push(performance.now() - start);
      }
    })(),
  );

  // Yield once so all tasks reach `await barrier.gate` before release.
  await Promise.resolve();
  barrier.release();

  const results = await Promise.allSettled(tasks);
  const fulfilled = results.filter((r): r is PromiseFulfilledResult<T> => r.status === 'fulfilled');
  const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');

  const timings = { durationsMs, ...percentiles(durationsMs) };
  // eslint-disable-next-line no-console
  console.log(
    `[concurrency] ${label}: n=${n} ok=${fulfilled.length} err=${rejected.length} ` +
      `p50=${timings.p50.toFixed(1)}ms p95=${timings.p95.toFixed(1)}ms p99=${timings.p99.toFixed(1)}ms`,
  );

  return { results, fulfilled, rejected, timings };
}

function percentiles(values: number[]): { p50: number; p95: number; p99: number } {
  if (values.length === 0) return { p50: 0, p95: 0, p99: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number): number => {
    const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
    return sorted[Math.max(0, idx)]!;
  };
  return { p50: at(50), p95: at(95), p99: at(99) };
}
