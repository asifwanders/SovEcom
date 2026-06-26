import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module';

/**
 * Boots the full Nest app against real Postgres / Redis / Meilisearch and asserts
 * the aggregated /health endpoint reports every subsystem as ok. Runs in CI with
 * service containers (DATABASE_URL / REDIS_URL / MEILISEARCH_URL set).
 */
describe('health (integration)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it('GET /health returns 200 with all subsystems ok', () => {
    return request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect((res) => {
        expect(res.body).toMatchObject({
          status: 'ok',
          postgres: 'ok',
          redis: 'ok',
          meilisearch: 'ok',
        });
        expect(typeof res.body.uptime).toBe('number');
      });
  });
});
