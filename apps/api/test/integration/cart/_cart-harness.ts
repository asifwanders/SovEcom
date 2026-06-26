/**
 * Cart integration harness.
 *
 * Boots the full AppModule against real Postgres + Redis; seeds a default tenant,
 * a published product with two variants, and exposes helpers for cart mutations.
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
import * as argon2 from 'argon2';
import { uuidv7 } from 'uuidv7';
import * as schema from '../../../src/database/schema';
import { AppModule } from '../../../src/app.module';
import { AllExceptionsFilter } from '../../../src/common/filters/all-exceptions.filter';
import { StoreTenantService } from '../../../src/catalog/store-tenant.service';
import { RedisService } from '../../../src/redis/redis.service';
import { TenantSettingsService } from '../../../src/taxes/tenant-settings.service';
import {
  VIES_CLIENT,
  type ViesClient,
  type ViesCheckResult,
} from '../../../src/customers/vies/vies.client';

const MIGRATIONS = 'src/database/migrations';
export const DEFAULT_TENANT_ID = '01900000-0000-7000-8000-000000000000';
export const CART_TOKEN_COOKIE = 'sov_cart';

export const newId = (): string => uuidv7();
export const uniqEmail = (): string =>
  `cart-test-${Date.now()}-${Math.random().toString(36).slice(2)}@test.invalid`;

/** Minimal stub ViesClient so no network egress */
class StubViesClient implements ViesClient {
  async check(_countryCode: string, _vatNumber: string): Promise<ViesCheckResult> {
    return { valid: false, name: null, address: null };
  }
}

export interface CartHarness {
  app: INestApplication;
  client: ReturnType<typeof postgres>;
  db: PostgresJsDatabase<typeof schema>;
  redis: Redis;
  http(): Express.Application;
}

export async function bootCartApp(): Promise<CartHarness> {
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

  // Reset rate-limit state and tenant cache. The RedisService client is
  // lazyConnect + enableOfflineQueue:false, so the first command would reject
  // with "Stream isn't writeable" unless we connect first — ping() establishes
  // the connection before we issue flushdb.
  const redisService = app.get(RedisService);
  await redisService.ping();
  const redis = redisService.client;
  await redis.flushdb();

  // Fix the StoreTenantService to return our pinned test tenant
  const storeTenant = app.get(StoreTenantService, { strict: false }) as unknown as {
    defaultTenantId: string | null;
  };
  storeTenant.defaultTenantId = DEFAULT_TENANT_ID;

  return { app, client, db, redis, http: () => app.getHttpServer() };
}

/**
 * Run a TRUNCATE, retrying a transient deadlock (40P01) with backoff. A fire-and-forget
 * post-commit op from a prior test (invoice / credit-note PDF render holding locks on
 * invoices/invoice_counters/refunds) can deadlock a CASCADE TRUNCATE that needs ACCESS EXCLUSIVE
 * on those. The loser rolls back harmlessly (its rows are being wiped anyway) and the retry
 * succeeds. Exported so every reset path is deadlock-resilient. Test-only.
 */
export async function truncateWithRetry(
  h: { client: CartHarness['client'] },
  sql: string,
  attempts = 15,
): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await h.client.unsafe(sql);
      return;
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      if (code === '40P01' && i < attempts - 1) {
        await new Promise((r) => setTimeout(r, 30 + i * 20));
        continue;
      }
      throw err;
    }
  }
}

export async function resetCartState(h: CartHarness): Promise<void> {
  await truncateWithRetry(
    h,
    `TRUNCATE TABLE
      discount_usages, discounts,
      cart_items, carts,
      product_tags, product_categories, product_images,
      product_variants, products, categories, tags,
      customer_addresses, customers,
      audit_log, refresh_tokens, password_reset_tokens, users,
      shipping_rates, shipping_zones, tax_rates
    RESTART IDENTITY CASCADE`,
  );
  await h.redis.flushdb();

  // Re-seed the default tenant only (tenants is not truncated above). Reset its
  // settings JSONB to {} so each test starts from the fresh-store default
  // (tax_mode='none', prices_include_tax=true) — a prior test's PUT must not leak.
  const existing = await h.client<{ id: string }[]>`
    select id from tenants where id = ${DEFAULT_TENANT_ID}
  `;
  if (existing.length === 0) {
    await h.client`
      insert into tenants (id, name, slug, settings) values (${DEFAULT_TENANT_ID}, ${'Test Tenant'}, ${'test'}, ${'{}'}::jsonb)
    `;
  } else {
    await h.client`update tenants set settings = ${'{}'}::jsonb where id = ${DEFAULT_TENANT_ID}`;
  }

  // Re-seed system_state so StoreTenantService can resolve tenant. `value` is
  // jsonb, so the tenant id must be wrapped as a JSON string via to_jsonb(...::text)
  // (matches the auth/catalog harnesses) — a bare uuid is invalid JSON.
  await h.client`
    insert into system_state (key, value)
    values ('default_tenant_id', to_jsonb(${DEFAULT_TENANT_ID}::text))
    on conflict (key) do update set value = excluded.value, updated_at = now()
  `;

  // Drop the in-process TenantSettingsService cache — it would otherwise serve the
  // PRIOR test's tax settings after we reset the JSONB to {} above.
  const settings = h.app.get(TenantSettingsService, { strict: false });
  settings.invalidate(DEFAULT_TENANT_ID);
}

/**
 * Seed a tenant-wide tax_rate (region NULL = country default). `rate` is the
 * NUMERIC(5,4) fraction string, e.g. "0.2000" for 20%.
 */
export async function seedTaxRate(
  h: CartHarness,
  country: string,
  rate: string,
  name = `VAT ${country}`,
): Promise<void> {
  await h.client`
    insert into tax_rates (id, tenant_id, country, region, rate, name)
    values (${newId()}, ${DEFAULT_TENANT_ID}, ${country}, ${null}, ${rate}, ${name})
  `;
}

/**
 * Write the tenant tax settings JSONB directly + invalidate the service cache.
 * used to put a cart into `eu_vat` mode for the integration tests.
 */
export async function setTaxSettings(
  h: CartHarness,
  settings: {
    taxMode?: 'none' | 'eu_vat';
    pricesIncludeTax?: boolean;
    ossPosture?: 'below_threshold' | 'above_or_opted_in';
    originCountry?: string | null;
    vatNumber?: string | null;
  },
): Promise<void> {
  const json: Record<string, unknown> = {};
  if (settings.taxMode !== undefined) json.tax_mode = settings.taxMode;
  if (settings.pricesIncludeTax !== undefined) json.prices_include_tax = settings.pricesIncludeTax;
  if (settings.ossPosture !== undefined) json.oss_posture = settings.ossPosture;
  if (settings.originCountry !== undefined || settings.vatNumber !== undefined) {
    json.eu_vat_registration = {
      origin_country: settings.originCountry ?? null,
      vat_number: settings.vatNumber ?? null,
    };
  }
  await h.client`
    update tenants set settings = ${JSON.stringify(json)}::jsonb, updated_at = now()
    where id = ${DEFAULT_TENANT_ID}
  `;
  const svc = h.app.get(TenantSettingsService, { strict: false });
  svc.invalidate(DEFAULT_TENANT_ID);
}

/** Seed a customer row directly (b2b/vat attributes); returns the id. */
export async function seedCustomerRow(
  h: CartHarness,
  opts: { isB2b?: boolean; vatValidated?: boolean; email?: string } = {},
): Promise<string> {
  const id = newId();
  const email = opts.email ?? uniqEmail();
  await h.client`
    insert into customers (id, tenant_id, email, is_b2b, vat_validated)
    values (${id}, ${DEFAULT_TENANT_ID}, ${email}, ${opts.isB2b ?? false}, ${opts.vatValidated ?? false})
  `;
  return id;
}

/** Seed tenant + published product + two variants; returns their IDs. */
export async function seedProductWithVariants(
  h: CartHarness,
): Promise<{ productId: string; variantId: string; variantId2: string; currency: string }> {
  const productId = newId();
  const variantId = newId();
  const variantId2 = newId();
  const currency = 'EUR';

  await h.client`
    insert into products (id, tenant_id, title, slug, status)
    values (${productId}, ${DEFAULT_TENANT_ID}, ${'Test Product'}, ${`test-product-${productId.slice(0, 8)}`}, ${'published'})
  `;
  await h.client`
    insert into product_variants (id, tenant_id, product_id, sku, title, options, price_amount, currency, stock_quantity)
    values
      (${variantId}, ${DEFAULT_TENANT_ID}, ${productId}, ${`SKU-A-${variantId.slice(0, 8)}`}, ${'Variant A'}, ${'{}'}::jsonb, ${1000}, ${currency}, ${10}),
      (${variantId2}, ${DEFAULT_TENANT_ID}, ${productId}, ${`SKU-B-${variantId2.slice(0, 8)}`}, ${'Variant B'}, ${'{}'}::jsonb, ${2000}, ${currency}, ${5})
  `;

  return { productId, variantId, variantId2, currency };
}

/** Seed a shipping zone + rate; returns the rate ID. */
export async function seedShippingRate(h: CartHarness, currency: string): Promise<string> {
  const zoneId = newId();
  const rateId = newId();
  await h.client`
    insert into shipping_zones (id, tenant_id, name, countries)
    values (${zoneId}, ${DEFAULT_TENANT_ID}, ${'EU Zone'}, ${JSON.stringify(['FR', 'DE'])}::jsonb)
  `;
  await h.client`
    insert into shipping_rates (id, tenant_id, zone_id, name, type, amount, currency)
    values (${rateId}, ${DEFAULT_TENANT_ID}, ${zoneId}, ${'Standard'}, ${'flat'}, ${500}, ${currency})
  `;
  return rateId;
}

/** Signup + login a customer; returns tokens. */
export async function signupAndLoginCustomer(
  h: CartHarness,
  overrides: { email?: string; password?: string } = {},
): Promise<{ customerId: string; email: string; accessToken: string }> {
  const email = overrides.email ?? uniqEmail();
  const password = overrides.password ?? 'correct horse battery staple';

  const signup = await request(h.http())
    .post('/store/v1/customers')
    .send({ email, password, name: 'Cart Test Customer' });
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

/**
 * Seed an admin user in the default tenant and return a logged-in access token.
 * Used by the discount admin-CRUD integration tests.
 */
export async function seedAdminAndLogin(
  h: CartHarness,
  role: 'owner' | 'admin' | 'staff' = 'admin',
): Promise<{ userId: string; email: string; accessToken: string }> {
  const id = newId();
  const email = `admin-${Date.now()}-${Math.random().toString(36).slice(2)}@test.invalid`;
  const password = 'correct horse battery staple';
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  await h.client`
    insert into users (id, tenant_id, email, password_hash, name, role)
    values (${id}, ${DEFAULT_TENANT_ID}, ${email}, ${passwordHash}, ${'Admin'}, ${role})
  `;
  const login = await request(h.http()).post('/admin/v1/auth/login').send({ email, password });
  if (login.status !== 200) {
    throw new Error(`admin login failed: ${login.status} ${JSON.stringify(login.body)}`);
  }
  return { userId: id, email, accessToken: login.body.accessToken as string };
}

/** Seed a category and link a product to it; returns the category id. */
export async function seedCategoryForProduct(h: CartHarness, productId: string): Promise<string> {
  const categoryId = newId();
  await h.client`
    insert into categories (id, tenant_id, name, slug)
    values (${categoryId}, ${DEFAULT_TENANT_ID}, ${'Test Cat'}, ${`cat-${categoryId.slice(0, 8)}`})
  `;
  await h.client`
    insert into product_categories (tenant_id, product_id, category_id)
    values (${DEFAULT_TENANT_ID}, ${productId}, ${categoryId})
  `;
  return categoryId;
}

/** Insert a discount row directly; returns its id. Minimal columns + overrides. */
export async function seedDiscount(
  h: CartHarness,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const id = newId();
  const d = {
    code: null as string | null,
    name: 'Seeded',
    type: 'percentage',
    value: 1000,
    currency: null as string | null,
    min_cart_amount: null as number | null,
    applies_to: 'all',
    target_ids: null as unknown,
    customer_segment: null as string | null,
    stackable: false,
    usage_limit_total: null as number | null,
    usage_limit_per_customer: null as number | null,
    starts_at: null as string | null,
    ends_at: null as string | null,
    active: true,
    ...overrides,
  };
  const targetIdsJson = d.target_ids === null ? null : JSON.stringify(d.target_ids);
  await h.client`
    insert into discounts (
      id, tenant_id, code, name, type, value, currency, min_cart_amount,
      applies_to, target_ids, customer_segment, stackable,
      usage_limit_total, usage_limit_per_customer, starts_at, ends_at, active
    ) values (
      ${id}, ${DEFAULT_TENANT_ID}, ${d.code}, ${d.name}, ${d.type}, ${d.value},
      ${d.currency}, ${d.min_cart_amount}, ${d.applies_to},
      ${targetIdsJson}::jsonb,
      ${d.customer_segment}, ${d.stackable}, ${d.usage_limit_total},
      ${d.usage_limit_per_customer}, ${d.starts_at}, ${d.ends_at}, ${d.active}
    )
  `;
  return id;
}

/** Extract the cart token from Set-Cookie response header. */
export function extractCartTokenCookie(res: request.Response): string {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  if (!raw) return '';
  const c = raw.find((x) => x.startsWith(`${CART_TOKEN_COOKIE}=`));
  return c ? c.split(';')[0]! : '';
}

/** Extract just the cookie value (the UUID). */
export function extractCartToken(res: request.Response): string {
  const pair = extractCartTokenCookie(res);
  return pair ? pair.split('=')[1]! : '';
}
