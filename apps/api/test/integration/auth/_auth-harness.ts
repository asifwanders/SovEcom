/**
 * Auth integration harness — SECURITY-CRITICAL.
 *
 * Boots the full Nest `AppModule` against a real Postgres + Redis (CI service
 * containers / docker-compose.dev locally), runs the Drizzle migrator, and
 * exposes the seams the security-acceptance-core specs need:
 *
 *   - `bootAuthApp()`        — INestApplication wired exactly like `main.ts`
 *                              (cookie-parser, trust proxy, global Zod pipe,
 *                              exception filter) so cookie/redaction behaviour is
 *                              under test, plus a raw `postgres` client + `Redis`.
 *   - `seedAdmin()`          — a real Argon2id admin in the *test harness only*
 *                              (never in shared seed.ts), with optional TOTP
 *                              enabled (AEAD secret + base32).
 *   - `login()/refreshOnce()`— thin supertest wrappers returning tokens + cookies.
 *   - `resetAuthState()`     — TRUNCATE the auth tables + FLUSHDB Redis between tests.
 *
 * Route base: controllers register absolute `admin/v1/auth/*` paths (no global
 * prefix in `main.ts`), so {@link AUTH} mirrors that.
 *
 * RED today: `src/auth/**` (the module, controllers, services) does not exist, so
 * `AppModule` does not register the auth routes, the AEAD/token services this
 * harness imports are absent, and every spec that calls these helpers fails to
 * COMPILE / 404s. That is the expected failing-first state.
 */
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ZodValidationPipe } from 'nestjs-zod';
import cookieParser from 'cookie-parser';
import * as crypto from 'node:crypto';
import postgres from 'postgres';
import { drizzle, PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import Redis from 'ioredis';
import * as argon2 from 'argon2';
import { authenticator } from 'otplib';
import { uuidv7 } from 'uuidv7';
import * as schema from '../../../src/database/schema';
import { AppModule } from '../../../src/app.module';
// The AEAD codec is shared so a seeded TOTP secret is stored exactly as the
// running service expects to decrypt it (AAD = userId). RED until it exists.
import { AeadService } from '../../../src/auth/crypto/aead.service';
import { AuthService } from '../../../src/auth/services/auth.service';
import { ResetService } from '../../../src/auth/services/reset.service';
import { AllExceptionsFilter } from '../../../src/common/filters/all-exceptions.filter';

export const MIGRATIONS = 'src/database/migrations';
export const AUTH = {
  login: '/admin/v1/auth/login',
  twoFa: '/admin/v1/auth/2fa',
  refresh: '/admin/v1/auth/refresh',
  logout: '/admin/v1/auth/logout',
  me: '/admin/v1/auth/me',
  enroll: '/admin/v1/auth/2fa/enroll',
  confirm: '/admin/v1/auth/2fa/confirm',
  disable: '/admin/v1/auth/2fa/disable',
  forgot: '/admin/v1/auth/password/forgot',
  reset: '/admin/v1/auth/password/reset',
} as const;

export type Sql = ReturnType<typeof postgres>;
export type Db = PostgresJsDatabase<typeof schema>;

export interface AuthHarness {
  app: INestApplication;
  http: () => ReturnType<INestApplication['getHttpServer']>;
  client: Sql;
  db: Db;
  redis: Redis;
  /** AEAD codec seeded with the SAME master key the running service uses. */
  aead: AeadService;
}

export const newId = (): string => uuidv7();
export const sha256 = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');

/**
 * Monotonic per-process counter for unique slugs / emails. NOTE: `uuidv7()` is
 * time-ordered, so `newId().slice(0, 8)` shares a prefix for ids minted in the
 * same millisecond and collides under a UNIQUE(slug)/email constraint — use this.
 */
let uniqueSeq = 0;
const uniq = (): string => `${(uniqueSeq++).toString(36)}-${newId().slice(-8)}`;

/**
 * The harness pins a deterministic 32-byte master key for the AEAD service so a
 * seeded TOTP secret round-trips through the running guard. The auth module must
 * read the same key (env `MASTER_KEY` / `/data/master.key`); we set it here.
 */
export const TEST_MASTER_KEY = Buffer.alloc(32, 0x2a);

/**
 * Single-tenant v1: `AuthService.login` / `ResetService` resolve the admin via
 * `system_state.default_tenant_id` (and CACHE it in-memory). The specs, however,
 * mint a *fresh random* primary tenant per test and expect login to resolve it
 * (e.g. the access-token `tid` must equal `tenant-a`). So the harness:
 *   - seeds a STABLE baseline default tenant on every reset, so no-seed flows
 *     (e.g. an unknown-email login with no prior seed) don't 500; and
 *   - on the FIRST `makeTenant` of each test, re-points `default_tenant_id` at
 *     that tenant and CLEARS the services' cached value so the next request
 *     re-reads it. (The login tenant is always the first tenant a test creates.)
 */
export const DEFAULT_TENANT_ID = '01900000-0000-7000-8000-000000000000';
let defaultOverridden = false;

/**
 * Point `system_state.default_tenant_id` (jsonb string) at `id` and invalidate
 * the in-memory cache the AuthService/ResetService hold so the next request
 * resolves the new tenant. `value` is `jsonb`, so it must hold a JSON string.
 */
async function setDefaultTenant(h: AuthHarness, id: string): Promise<void> {
  await h.client`
    insert into system_state (key, value)
    values ('default_tenant_id', to_jsonb(${id}::text))
    on conflict (key) do update set value = excluded.value, updated_at = now()
  `;
  type Cached = { defaultTenantId: string | null };
  (h.app.get(AuthService, { strict: false }) as unknown as Cached).defaultTenantId = null;
  (h.app.get(ResetService, { strict: false }) as unknown as Cached).defaultTenantId = null;
}

export async function bootAuthApp(opts: { controllers?: unknown[] } = {}): Promise<AuthHarness> {
  // Pin secrets the auth module reads, so this harness and the running app agree.
  process.env.JWT_SECRET ??= 'integration-jwt-secret-integration-jwt-secret-32+';
  process.env.MASTER_KEY ??= TEST_MASTER_KEY.toString('base64');
  process.env.NODE_ENV = 'test';

  const url = process.env.DATABASE_URL as string;
  const client = postgres(url, { max: 4 });
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });

  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');

  // `controllers` lets the authorization suite mount a test-only controller with
  // permission-gated routes WITHOUT polluting AppModule; the global guards from
  // the imported AppModule still apply to it.
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
    controllers: (opts.controllers ?? []) as never[],
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  // Mirror main.ts boundary infra so cookie + redaction + Zod behaviour is tested.
  app.set('trust proxy', 1);
  app.use(cookieParser());
  app.useGlobalPipes(new ZodValidationPipe());
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();

  const aead = new AeadService(TEST_MASTER_KEY);
  return { app, http: () => app.getHttpServer(), client, db, redis, aead };
}

export async function teardownAuthApp(h: AuthHarness): Promise<void> {
  if (h.app) await h.app.close();
  if (h.client) await h.client.end({ timeout: 5 });
  if (h.redis) await h.redis.quit();
}

/** Wipe auth state + Redis between tests (serial suite, shared services). */
export async function resetAuthState(h: AuthHarness): Promise<void> {
  await h.client.unsafe(`
    TRUNCATE TABLE
      audit_log, password_reset_tokens, refresh_tokens, users, tenants
    RESTART IDENTITY CASCADE
  `);
  await h.redis.flushdb();
  // Re-establish a stable baseline default tenant so flows that resolve the
  // default tenant without seeding one (e.g. an unknown-email login) never throw.
  await h.client`
    insert into tenants (id, name, slug)
    values (${DEFAULT_TENANT_ID}, ${'Default'}, ${'default'})
    on conflict (id) do nothing
  `;
  await setDefaultTenant(h, DEFAULT_TENANT_ID);
  defaultOverridden = false;
}

export async function makeTenant(h: AuthHarness, slug = `t-${uniq()}`): Promise<string> {
  const id = newId();
  await h.client`insert into tenants (id, name, slug) values (${id}, ${slug}, ${slug})`;
  // The first tenant a test creates becomes the (login) default tenant.
  if (!defaultOverridden) {
    await setDefaultTenant(h, id);
    defaultOverridden = true;
  }
  return id;
}

/** The admin roles (mirrors the `user_role` pg enum). */
export type SeedRole = 'owner' | 'admin' | 'staff';

export interface SeededAdmin {
  id: string;
  tenantId: string;
  email: string;
  password: string;
  role: SeedRole;
  /** base32 TOTP secret when `withTotp` was set, else undefined. */
  totpSecret?: string;
}

/**
 * Seeds a real Argon2id user for test-harness use only. Defaults to `role='admin'`;
 * pass `role` to seed `owner`/`staff` for RBAC tests. When `withTotp` is set,
 * generates a base32 secret, AEAD-encrypts it bound to the new userId, and flips
 * `totp_enabled=true` (the CHECK requires the secret).
 */
export async function seedAdmin(
  h: AuthHarness,
  opts: {
    tenantId?: string;
    email?: string;
    password?: string;
    withTotp?: boolean;
    role?: SeedRole;
  } = {},
): Promise<SeededAdmin> {
  const tenantId = opts.tenantId ?? (await makeTenant(h));
  const email = (opts.email ?? `admin-${uniq()}@x.test`).toLowerCase();
  const password = opts.password ?? 'correct horse battery staple';
  const role = opts.role ?? 'admin';
  const id = newId();
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });

  let totpSecret: string | undefined;
  let totpEnc: string | null = null;
  if (opts.withTotp) {
    totpSecret = authenticator.generateSecret();
    totpEnc = h.aead.encrypt(totpSecret, id);
  }

  await h.client`
    insert into users (id, tenant_id, email, password_hash, name, role, totp_enabled, totp_secret)
    values (${id}, ${tenantId}, ${email}, ${passwordHash}, ${'Admin'}, ${role},
            ${opts.withTotp ?? false}, ${totpEnc})
  `;
  return { id, tenantId, email, password, role, totpSecret };
}

/** Count refresh-token rows for a user, optionally only live (non-revoked). */
export async function countRefresh(
  h: AuthHarness,
  userId: string,
  liveOnly = false,
): Promise<number> {
  const rows = liveOnly
    ? await h.client<{ c: string }[]>`
        select count(*)::int as c from refresh_tokens
        where user_id = ${userId} and revoked_at is null`
    : await h.client<{ c: string }[]>`
        select count(*)::int as c from refresh_tokens where user_id = ${userId}`;
  return Number(rows[0].c);
}

/** Read audit rows for an action (most-recent first). */
export async function auditRows(
  h: AuthHarness,
  action: string,
): Promise<Array<Record<string, unknown>>> {
  return h.client<Array<Record<string, unknown>>>`
    select * from audit_log where action = ${action} order by created_at desc
  `;
}

/** Pull the most recent password-reset token row's hash for a user. */
export async function latestResetHash(h: AuthHarness, userId: string): Promise<string | null> {
  const rows = await h.client<{ token_hash: string }[]>`
    select token_hash from password_reset_tokens
    where user_id = ${userId} order by created_at desc limit 1
  `;
  return rows[0]?.token_hash ?? null;
}

/** Current token_version for a user (reset/logout-all bumps it). */
export async function tokenVersion(h: AuthHarness, userId: string): Promise<number> {
  const rows = await h.client<{ token_version: number }[]>`
    select token_version from users where id = ${userId}
  `;
  return rows[0].token_version;
}

/** Generate a live TOTP code for a base32 secret. */
export const totpNow = (secret: string): string => authenticator.generate(secret);

/**
 * Generate a code for the NEXT 30s step. A TOTP code is single-use across the
 * server-side replay guard, so a second sensitive action in the same window
 * (e.g. disabling 2FA right after a 2FA login) needs a FRESH code. The next-step
 * code still verifies under the service's ±1-step window but has a distinct
 * matched step, so it is not rejected as a replay.
 */
export const totpNext = (secret: string): string =>
  authenticator.generate(secret, Math.floor(Date.now() / 1000) + 30);
