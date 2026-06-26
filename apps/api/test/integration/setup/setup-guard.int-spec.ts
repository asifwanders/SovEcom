/**
 * SetupTokenGuard lockdown integration (SECURITY-CRITICAL).
 *
 * The guard gates the FUTURE 3.2 setup-step routes; 3.1 proves its behaviour by
 * mounting a throwaway probe controller behind it (the global JwtAuthGuard is
 * skipped via @Public, so this exercises the SetupTokenGuard in isolation — the
 * positive gate). Asserts:
 *   - not-installed + valid X-Setup-Token  → 200 (admitted);
 *   - not-installed + missing/invalid token → 404 (uniform hiding, NOT 401/403);
 *   - installed=true                         → 404 even WITH a valid token
 *                                              (post-install lockdown hides existence);
 *   - GET /setup/v1/status stays reachable post-install (it is NOT guarded).
 *
 * The 404 (not 403) choice uses "hide the surface" — a 403 would confirm the
 * endpoint exists.
 */
import 'reflect-metadata';
import { Controller, Get, INestApplication, Module, UseGuards } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ZodValidationPipe } from 'nestjs-zod';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import Redis from 'ioredis';
import * as schema from '../../../src/database/schema';
import { AppModule } from '../../../src/app.module';
import { AllExceptionsFilter } from '../../../src/common/filters/all-exceptions.filter';
import { Public } from '../../../src/auth/decorators/public.decorator';
import { SetupModule } from '../../../src/setup/setup.module';
import { SetupTokenGuard } from '../../../src/setup/guards/setup-token.guard';
import { SetupTokenService } from '../../../src/setup/setup-token.service';

const MIGRATIONS = 'src/database/migrations';
const PROBE_PATH = '/setup/v1/__probe';

/**
 * Throwaway 3.2-shaped route: @Public (skip global JWT guard) + SetupTokenGuard.
 * Stands in for a real setup-step endpoint so the guard is under test today.
 */
@Controller('setup/v1')
class SetupProbeController {
  @Public()
  @UseGuards(SetupTokenGuard)
  @Get('__probe')
  probe(): { ok: true } {
    return { ok: true };
  }
}

/**
 * Wraps the probe in a module that imports SetupModule, so SetupTokenGuard's deps
 * (SetupStateService / SetupTokenService — exported by SetupModule) resolve. A
 * controller mounted at the root test module would not see SetupModule's providers.
 */
@Module({ imports: [SetupModule], controllers: [SetupProbeController] })
class SetupProbeModule {}

describe('SetupTokenGuard lockdown (integration, SECURITY-CRITICAL)', () => {
  let app: INestApplication;
  let client: ReturnType<typeof postgres>;
  let redis: Redis;
  let tokens: SetupTokenService;

  beforeAll(async () => {
    process.env.JWT_SECRET ??= 'integration-jwt-secret-integration-jwt-secret-32+';
    process.env.MASTER_KEY ??= Buffer.alloc(32, 0x2a).toString('base64');
    process.env.NODE_ENV = 'test';

    const url = process.env.DATABASE_URL as string;
    client = postgres(url, { max: 4 });
    await migrate(drizzle(client, { schema }), { migrationsFolder: MIGRATIONS });
    redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule, SetupProbeModule],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    app.set('trust proxy', 1);
    app.use(cookieParser());
    app.useGlobalPipes(new ZodValidationPipe());
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    tokens = app.get(SetupTokenService, { strict: false });
  });

  afterAll(async () => {
    await app?.close();
    await client?.end({ timeout: 5 });
    await redis?.quit();
  });

  beforeEach(async () => {
    await client.unsafe(`TRUNCATE TABLE setup_tokens RESTART IDENTITY`);
    await client.unsafe(`DELETE FROM system_state WHERE key = 'installed'`);
    await redis.flushdb();
  });

  const setInstalled = async (value: boolean): Promise<void> => {
    await client`
      insert into system_state (key, value)
      values ('installed', to_jsonb(${value}::boolean))
      on conflict (key) do update set value = excluded.value, updated_at = now()
    `;
  };

  it('not-installed + valid X-Setup-Token → 200 (admitted)', async () => {
    await setInstalled(false);
    const token = await tokens.generateToken();
    await request(app.getHttpServer())
      .get(PROBE_PATH)
      .set('X-Setup-Token', token)
      .expect(200, { ok: true });
  });

  it('not-installed + MISSING token → 404 (hidden, not 401/403)', async () => {
    await setInstalled(false);
    await request(app.getHttpServer()).get(PROBE_PATH).expect(404);
  });

  it('not-installed + INVALID token → 404 (hidden, not 401/403)', async () => {
    await setInstalled(false);
    await request(app.getHttpServer())
      .get(PROBE_PATH)
      .set('X-Setup-Token', 'wrong-token')
      .expect(404);
  });

  it('installed=true → 404 EVEN WITH a valid token (post-install lockdown hides existence)', async () => {
    await setInstalled(false);
    const token = await tokens.generateToken();
    await setInstalled(true);
    await request(app.getHttpServer()).get(PROBE_PATH).set('X-Setup-Token', token).expect(404);
  });

  it('GET /setup/v1/status stays reachable post-install (it is NOT guarded)', async () => {
    await setInstalled(true);
    const res = await request(app.getHttpServer()).get('/setup/v1/status').expect(200);
    expect(res.body).toEqual({ installed: true, requiresToken: false });
  });
});
