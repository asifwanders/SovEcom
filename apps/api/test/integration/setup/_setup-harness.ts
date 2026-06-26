/**
 * Setup integration harness (SECURITY-CRITICAL).
 *
 * Boots the full Nest `AppModule` against a real Postgres + Redis, runs the
 * Drizzle migrator (so the existing `setup_tokens` / `system_state` tables are
 * present — NO migration is added), and wires the same boundary infra as
 * `main.ts` (trust proxy, global Zod pipe, exception filter) so the @Public
 * status/verify-token routes and the 404 lockdown behave exactly as in prod.
 *
 * The boot service's AUTOMATIC mint is suppressed under NODE_ENV=test (see
 * SetupBootService), so each test controls the `installed` flag via
 * {@link setInstalled} and drives the boot sequence explicitly via
 * {@link runBoot} (the public `SetupBootService.runBootSequence`).
 */
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ZodValidationPipe } from 'nestjs-zod';
import cookieParser from 'cookie-parser';
import postgres from 'postgres';
import { drizzle, PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import Redis from 'ioredis';
import * as schema from '../../../src/database/schema';
import { AppModule } from '../../../src/app.module';
import { AllExceptionsFilter } from '../../../src/common/filters/all-exceptions.filter';
import { SetupBootService } from '../../../src/setup/setup-boot.service';
import { SetupTokenService } from '../../../src/setup/setup-token.service';

export const MIGRATIONS = 'src/database/migrations';
export const SETUP = {
  status: '/setup/v1/status',
  verify: '/setup/v1/verify-token',
} as const;

export type Sql = ReturnType<typeof postgres>;
export type Db = PostgresJsDatabase<typeof schema>;

export interface SetupHarness {
  app: INestApplication;
  http: () => ReturnType<INestApplication['getHttpServer']>;
  client: Sql;
  db: Db;
  redis: Redis;
  boot: SetupBootService;
  tokens: SetupTokenService;
}

export async function bootSetupApp(): Promise<SetupHarness> {
  process.env.JWT_SECRET ??= 'integration-jwt-secret-integration-jwt-secret-32+';
  process.env.MASTER_KEY ??= Buffer.alloc(32, 0x2a).toString('base64');
  process.env.NODE_ENV = 'test';

  const url = process.env.DATABASE_URL as string;
  const client = postgres(url, { max: 4 });
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });

  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  app.set('trust proxy', 1);
  app.use(cookieParser());
  app.useGlobalPipes(new ZodValidationPipe());
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();

  const boot = app.get(SetupBootService, { strict: false });
  const tokens = app.get(SetupTokenService, { strict: false });

  return { app, http: () => app.getHttpServer(), client, db, redis, boot, tokens };
}

export async function teardownSetupApp(h: SetupHarness): Promise<void> {
  if (h.app) await h.app.close();
  if (h.client) await h.client.end({ timeout: 5 });
  if (h.redis) await h.redis.quit();
}

/** Wipe setup state + Redis between tests (serial suite, shared services). */
export async function resetSetupState(h: SetupHarness): Promise<void> {
  await h.client.unsafe(`TRUNCATE TABLE setup_tokens RESTART IDENTITY`);
  await h.client.unsafe(`DELETE FROM system_state WHERE key = 'installed'`);
  await h.redis.flushdb();
}

/**
 * Stage the `installed` flag. `true`/`false` upsert a jsonb boolean; passing
 * `undefined` removes the row entirely (the production "no seed" case, which the
 * state service must read as not-installed).
 */
export async function setInstalled(h: SetupHarness, value: boolean | undefined): Promise<void> {
  if (value === undefined) {
    await h.client`delete from system_state where key = 'installed'`;
    return;
  }
  await h.client`
    insert into system_state (key, value)
    values ('installed', to_jsonb(${value}::boolean))
    on conflict (key) do update set value = excluded.value, updated_at = now()
  `;
}

/** Run the real boot sequence (test-suppressed automatic path is bypassed). */
export async function runBoot(h: SetupHarness): Promise<void> {
  await h.boot.runBootSequence();
}

/** Count setup-token rows, optionally only the live (unused, unexpired) ones. */
export async function countTokens(h: SetupHarness, liveOnly = false): Promise<number> {
  const rows = liveOnly
    ? await h.client<{ c: number }[]>`
        select count(*)::int as c from setup_tokens
        where used_at is null and expires_at > now()`
    : await h.client<{ c: number }[]>`select count(*)::int as c from setup_tokens`;
  return Number(rows[0].c);
}

/** The single live token row (unused, unexpired), or null. */
export async function liveTokenRow(
  h: SetupHarness,
): Promise<{ token_hash: string; expires_at: Date; used_at: Date | null } | null> {
  const rows = await h.client<
    { token_hash: string; expires_at: Date | string; used_at: Date | string | null }[]
  >`
    select token_hash, expires_at, used_at from setup_tokens
    where used_at is null and expires_at > now()
    order by created_at desc limit 1
  `;
  const row = rows[0];
  if (!row) return null;
  // The raw `postgres` client may hand back timestamps as Date or ISO string
  // depending on driver config; normalise so callers can use `.getTime()`.
  return {
    token_hash: row.token_hash,
    expires_at: new Date(row.expires_at),
    used_at: row.used_at === null ? null : new Date(row.used_at),
  };
}
