/**
 * Customers integration harness (SECURITY-CRITICAL).
 *
 * Builds on the 1.2 auth harness: boots the full AppModule against real
 * Postgres + Redis, but OVERRIDES the VIES_CLIENT provider with a controllable
 * mock so no network egress happens in CI and the test can drive
 * valid / invalid / unreachable outcomes. Adds:
 *   - `bootCustomersApp()`     — like bootAuthApp, with the VIES mock bound and
 *                                `STORE_ORIGIN` (exported as {@link STORE_ORIGIN})
 *                                pinned so the customer refresh CSRF/Origin allow-
 *                                list reflects prod (F6) and Origin-bearing refresh
 *                                requests are accepted while foreign Origins 403.
 *   - `resetCustomersState()`  — TRUNCATE the customer + auth tables + FLUSHDB.
 *   - `MockViesClient`         — `.queue(result)` enqueues the next VIES outcome;
 *                                `.calls` proves the mock (not a real network) ran.
 *   - signup/login/refresh supertest helpers + cookie extraction.
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
import * as schema from '../../../src/database/schema';
import { AppModule } from '../../../src/app.module';
import { AllExceptionsFilter } from '../../../src/common/filters/all-exceptions.filter';
import { StoreTenantService } from '../../../src/catalog/store-tenant.service';
import { TenantSettingsService } from '../../../src/taxes/tenant-settings.service';
import { AuthService } from '../../../src/auth/services/auth.service';
import { RateLimitService } from '../../../src/auth/services/rate-limit.service';
import { RedisService } from '../../../src/redis/redis.service';
import {
  VIES_CLIENT,
  type ViesClient,
  type ViesCheckResult,
} from '../../../src/customers/vies/vies.client';

const MIGRATIONS = 'src/database/migrations';
export const DEFAULT_TENANT_ID = '01900000-0000-7000-8000-000000000000';

/** The store Origin pinned for the customer refresh CSRF allowlist (F6). */
export const STORE_ORIGIN = 'https://store.test';

export const STORE = {
  signup: '/store/v1/customers',
  login: '/store/v1/customers/login',
  refresh: '/store/v1/customers/refresh',
  logout: '/store/v1/customers/logout',
  me: '/store/v1/customers/me',
  addresses: '/store/v1/customers/me/addresses',
  export: '/store/v1/customers/me/rgpd/export',
  erase: '/store/v1/customers/me/rgpd/erase',
} as const;

export const ADMIN = {
  customers: '/admin/v1/customers',
  login: '/admin/v1/auth/login',
  refresh: '/admin/v1/auth/refresh',
  logout: '/admin/v1/auth/logout',
  products: '/admin/v1/products',
} as const;

export const CUSTOMER_REFRESH_COOKIE = 'sov_customer_refresh';
export const ADMIN_REFRESH_COOKIE = 'sov_refresh';

/** Strip the `name=value` (sans attrs) from a Set-Cookie line for a given name. */
export function cookieValuePair(res: request.Response, name: string): string {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  if (!raw) return '';
  const c = raw.find((x) => x.startsWith(`${name}=`));
  return c ? c.split(';')[0]! : '';
}

/** The raw opaque token from a `name=value` cookie pair (value only). */
export function rawTokenFromCookie(pair: string): string {
  const eq = pair.indexOf('=');
  return eq >= 0 ? pair.slice(eq + 1) : '';
}

export type Sql = ReturnType<typeof postgres>;
export type Db = PostgresJsDatabase<typeof schema>;

/**
 * Controllable VIES mock. `next` is a FIFO queue of results; if empty it falls
 * back to `fallback`. Every `check` increments `calls` so a test can assert the
 * mock (never a real network) handled the validation.
 */
export class MockViesClient implements ViesClient {
  calls = 0;
  private next: ViesCheckResult[] = [];
  fallback: ViesCheckResult = { status: 'unreachable' };

  queue(result: ViesCheckResult): void {
    this.next.push(result);
  }

  reset(): void {
    this.calls = 0;
    this.next = [];
    this.fallback = { status: 'unreachable' };
  }

  check(): Promise<ViesCheckResult> {
    this.calls += 1;
    const r = this.next.shift() ?? this.fallback;
    return Promise.resolve(r);
  }
}

export interface CustomersHarness {
  app: INestApplication;
  http: () => ReturnType<INestApplication['getHttpServer']>;
  client: Sql;
  db: Db;
  redis: Redis;
  vies: MockViesClient;
}

export const newId = (): string => uuidv7();
let uniqueSeq = 0;
export const uniqEmail = (): string =>
  `cust-${(uniqueSeq++).toString(36)}-${newId().slice(-8)}@x.test`;

export async function bootCustomersApp(): Promise<CustomersHarness> {
  process.env.JWT_SECRET ??= 'integration-jwt-secret-integration-jwt-secret-32+';
  process.env.MASTER_KEY ??= Buffer.alloc(32, 0x2a).toString('base64');
  // F6: pin the customer refresh CSRF/Origin allowlist so an Origin-bearing refresh
  // is accepted (matching STORE_ORIGIN) and a foreign Origin is rejected (403).
  process.env.STORE_ORIGIN = STORE_ORIGIN;
  process.env.NODE_ENV = 'test';

  const url = process.env.DATABASE_URL as string;
  const client = postgres(url, { max: 4 });
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });

  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
  const vies = new MockViesClient();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(VIES_CLIENT)
    .useValue(vies)
    .compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>();
  app.set('trust proxy', 1);
  app.use(cookieParser());
  app.useGlobalPipes(new ZodValidationPipe());
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();

  return { app, http: () => app.getHttpServer(), client, db, redis, vies };
}

export async function teardownCustomersApp(h: CustomersHarness | undefined): Promise<void> {
  if (!h) return;
  if (h.app) await h.app.close();
  if (h.client) await h.client.end({ timeout: 5 });
  if (h.redis) await h.redis.quit();
}

/** Wipe customer + auth state + Redis, and re-seed the default tenant + pointer. */
export async function resetCustomersState(h: CustomersHarness): Promise<void> {
  await h.client.unsafe(`
    TRUNCATE TABLE
      audit_log, refresh_tokens, customer_addresses, customers, users, tenants
    RESTART IDENTITY CASCADE
  `);
  await h.redis.flushdb();
  // DETERMINISM: under the long serial suite the APP's ioredis client can drop and
  // (by its `retryStrategy: () => null` design — out of 1.8 scope) never reconnect,
  // after which the rate-limiter fails CLOSED and its in-process fallback counter
  // bleeds across tests (an earlier signup/login then 401/429s spuriously). The
  // harness owns test isolation, so between tests we (a) reconnect the app Redis
  // client if it is not ready, and (b) clear the RateLimitService fallback map —
  // neither changes production RedisService behaviour.
  await ensureAppRedisReady(h);
  clearRateLimitFallback(h);
  await h.client`
    insert into tenants (id, name, slug)
    values (${DEFAULT_TENANT_ID}, ${'Default'}, ${'default'})
    on conflict (id) do nothing
  `;
  await setDefaultTenant(h, DEFAULT_TENANT_ID);
  h.vies.reset();
}

/** Reconnect the app's ioredis client if it dropped (test isolation only). */
async function ensureAppRedisReady(h: CustomersHarness): Promise<void> {
  try {
    const redisSvc = h.app.get(RedisService, { strict: false });
    const status = (redisSvc.client as { status?: string }).status;
    if (status !== 'ready' && status !== 'connecting') {
      await redisSvc.client.connect();
    }
  } catch {
    // Best-effort: a still-down Redis means the rate-limiter fails closed (its
    // documented behaviour); the fallback clear below keeps the count deterministic.
  }
}

/** Clear the RateLimitService in-process fail-closed fallback (test isolation only). */
function clearRateLimitFallback(h: CustomersHarness): void {
  try {
    const rl = h.app.get(RateLimitService, { strict: false }) as unknown as {
      fallback?: Map<string, unknown>;
    };
    rl.fallback?.clear();
  } catch {
    /* provider not present in this app graph — nothing to clear */
  }
}

/**
 * Set the tenant's tax regime + invalidate the TenantSettingsService cache.
 * VIES validation is gated on `tax_mode='eu_vat'`, so the VIES suite opts the
 * default tenant INTO eu_vat; the `none` default is the non-EU path.
 */
export async function setTenantTaxMode(
  h: CustomersHarness,
  mode: 'none' | 'eu_vat',
  tenantId: string = DEFAULT_TENANT_ID,
): Promise<void> {
  const settings =
    mode === 'eu_vat'
      ? { tax_mode: 'eu_vat', eu_vat_registration: { origin_country: 'FR', vat_number: null } }
      : { tax_mode: 'none' };
  await h.client`
    update tenants set settings = ${JSON.stringify(settings)}::jsonb, updated_at = now()
    where id = ${tenantId}
  `;
  h.app.get(TenantSettingsService, { strict: false }).invalidate(tenantId);
}

/** Create an extra tenant (for cross-tenant admin isolation tests). */
export async function makeTenant(h: CustomersHarness, slug: string): Promise<string> {
  const id = newId();
  await h.client`insert into tenants (id, name, slug) values (${id}, ${slug}, ${slug})`;
  return id;
}

/** Point system_state.default_tenant_id at `id` and invalidate the cached value. */
export async function setDefaultTenant(h: CustomersHarness, id: string): Promise<void> {
  await h.client`
    insert into system_state (key, value)
    values ('default_tenant_id', to_jsonb(${id}::text))
    on conflict (key) do update set value = excluded.value, updated_at = now()
  `;
  type Cached = { defaultTenantId: string | null };
  (h.app.get(StoreTenantService, { strict: false }) as unknown as Cached).defaultTenantId = null;
  // AuthService also caches the default tenant (admin login resolves it).
  (h.app.get(AuthService, { strict: false }) as unknown as Cached).defaultTenantId = null;
}

/** Seed a real Argon2id admin directly (mirrors the auth harness) for RBAC tests. */
export async function seedAdmin(
  h: CustomersHarness,
  opts: { tenantId: string; role?: 'owner' | 'admin' | 'staff'; email?: string; password?: string },
): Promise<{ id: string; email: string; password: string; role: string }> {
  const argon2 = await import('argon2');
  const email = (opts.email ?? uniqEmail()).toLowerCase();
  const password = opts.password ?? 'correct horse battery staple';
  const role = opts.role ?? 'admin';
  const id = newId();
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  await h.client`
    insert into users (id, tenant_id, email, password_hash, name, role, totp_enabled)
    values (${id}, ${opts.tenantId}, ${email}, ${passwordHash}, ${'Admin'}, ${role}, ${false})
  `;
  return { id, email, password, role };
}

/** Admin login → access token (admin must resolve the same default tenant). */
export async function adminLogin(
  h: CustomersHarness,
  admin: { email: string; password: string },
): Promise<string> {
  const res = await request(h.http())
    .post(ADMIN.login)
    .send({ email: admin.email, password: admin.password });
  return res.body.accessToken as string;
}

/** Admin login → access token + the admin refresh cookie pair (`sov_refresh=...`). */
export async function adminLoginWithCookie(
  h: CustomersHarness,
  admin: { email: string; password: string },
): Promise<{ accessToken: string; refreshCookie: string }> {
  const res = await request(h.http())
    .post(ADMIN.login)
    .send({ email: admin.email, password: admin.password });
  return {
    accessToken: res.body.accessToken as string,
    refreshCookie: cookieValuePair(res, ADMIN_REFRESH_COOKIE),
  };
}

export interface CustomerSession {
  customerId: string;
  email: string;
  password: string;
  accessToken: string;
  refreshCookie: string;
}

/** Signup + login a fresh customer; returns tokens + the refresh cookie. */
export async function signupAndLogin(
  h: CustomersHarness,
  overrides: { email?: string; password?: string } = {},
): Promise<CustomerSession> {
  const email = overrides.email ?? uniqEmail();
  const password = overrides.password ?? 'correct horse battery staple';
  const signup = await request(h.http())
    .post(STORE.signup)
    .send({ email, password, name: 'Test Customer' });
  if (signup.status !== 201) {
    throw new Error(`signup failed: ${signup.status} ${JSON.stringify(signup.body)}`);
  }
  const customerId = signup.body.id as string;
  const login = await request(h.http()).post(STORE.login).send({ email, password });
  if (login.status !== 200) {
    throw new Error(`login failed: ${login.status} ${JSON.stringify(login.body)}`);
  }
  return {
    customerId,
    email,
    password,
    accessToken: login.body.accessToken as string,
    refreshCookie: extractRefreshCookie(login),
  };
}

/** Pull the customer refresh cookie value+attrs from a supertest response. */
export function extractRefreshCookie(res: request.Response): string {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  if (!raw) return '';
  const cookie = raw.find((c) => c.startsWith(`${CUSTOMER_REFRESH_COOKIE}=`));
  return cookie ? cookie.split(';')[0]! : '';
}

/** Read audit rows for an action (most-recent first). */
export async function auditRows(
  h: CustomersHarness,
  action: string,
): Promise<Array<Record<string, unknown>>> {
  return h.client<Array<Record<string, unknown>>>`
    select * from audit_log where action = ${action} order by created_at desc
  `;
}

/** Raw customer row (bypassing the service) for white-box assertions. */
export async function rawCustomer(
  h: CustomersHarness,
  id: string,
): Promise<Record<string, unknown> | undefined> {
  const rows = await h.client<Array<Record<string, unknown>>>`
    select * from customers where id = ${id}
  `;
  return rows[0];
}

/** Count live (non-revoked) refresh tokens for a customer. */
export async function countLiveRefresh(h: CustomersHarness, customerId: string): Promise<number> {
  const rows = await h.client<{ c: string }[]>`
    select count(*)::int as c from refresh_tokens
    where customer_id = ${customerId} and revoked_at is null
  `;
  return Number(rows[0]!.c);
}
