/**
 * OpenAPI spec dump.
 *
 * Emits `apps/api/openapi.json` (the committed source for `@sovecom/client-js`'s generated
 * types) from the LIVE AppModule metadata, using the SAME DocumentBuilder config as `main.ts`
 * so the dumped spec matches what the running API serves at `/admin/v1/openapi.json`.
 *
 * Runs as a jest spec (not a standalone ts-node script) because booting AppModule transitively
 * imports otplib/meilisearch (ESM-only) which only the ts-jest pipeline downlevels + shims.
 * It deliberately SKIPS `app.init()`: `SwaggerModule.createDocument` only scans metadata, so no
 * DB/Redis/Meilisearch connection is opened (DatabaseService is lazy, RedisService lazyConnect).
 * It doubles as a guard: it asserts the emitted spec is valid OpenAPI 3 with the store paths.
 */
import { writeFileSync } from 'fs';
import { join } from 'path';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { SwaggerModule } from '@nestjs/swagger';
import { AppModule } from '../../src/app.module';
import { buildOpenApiConfig } from '../../src/common/openapi.config';

const OUTPUT_PATH = join(__dirname, '..', '..', 'openapi.json');

describe('OpenAPI spec dump', () => {
  let app: INestApplication;
  const originalDbUrl = process.env.DATABASE_URL;

  beforeAll(async () => {
    // Dummy infra URLs so the lazy DatabaseService/RedisService constructors don't throw.
    // No connection is opened — we never call app.init().
    process.env.DATABASE_URL ??= 'postgres://localhost:5432/openapi-dump';
    process.env.REDIS_URL ??= 'redis://localhost:6379';
    process.env.MEILISEARCH_URL ??= 'http://localhost:7700';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
  }, 30_000);

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    process.env.DATABASE_URL = originalDbUrl;
  });

  it('emits a valid OpenAPI 3 spec covering the store + admin surface', () => {
    // Shared config with main.ts — they cannot diverge (see common/openapi.config.ts).
    const document = SwaggerModule.createDocument(app, buildOpenApiConfig());

    expect(document.openapi).toMatch(/^3\./);
    expect(document.info.title).toBe('SovEcom API');
    // The storefront surface the client library wraps must be present.
    expect(document.paths).toHaveProperty('/store/v1/orders/by-number/{orderNumber}');
    expect(document.paths).toHaveProperty('/store/v1/carts/{cartId}/checkout');

    // Stable 2-space JSON so the committed artifact diffs cleanly between regenerations.
    writeFileSync(OUTPUT_PATH, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  });
});
