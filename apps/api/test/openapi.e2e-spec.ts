import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { SwaggerModule } from '@nestjs/swagger';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { buildOpenApiConfig } from '../src/common/openapi.config';

describe('OpenAPI (e2e)', () => {
  let app: INestApplication;
  const originalEnv = process.env.DATABASE_URL;

  beforeEach(async () => {
    // Provide a dummy DATABASE_URL so the DatabaseService constructor doesn't throw
    process.env.DATABASE_URL = 'postgres://localhost:5432/test';
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.MEILISEARCH_URL = 'http://localhost:7700';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();

    // Set up Swagger using the SAME shared config as main.ts + the spec dump (no third copy).
    const document = SwaggerModule.createDocument(app, buildOpenApiConfig());
    SwaggerModule.setup('admin/v1/docs', app, document, {
      jsonDocumentUrl: 'admin/v1/openapi.json',
    });

    await app.init();
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
    process.env.DATABASE_URL = originalEnv;
  });

  it('GET /admin/v1/openapi.json should return valid OpenAPI 3.0 spec', () => {
    return request(app.getHttpServer())
      .get('/admin/v1/openapi.json')
      .expect(200)
      .expect('Content-Type', /json/)
      .expect((res) => {
        // NestJS Swagger generates OpenAPI 3.0 by default
        expect(res.body).toHaveProperty('openapi');
        expect(res.body.openapi).toMatch(/^3\./);
        expect(res.body).toHaveProperty('info');
        expect(res.body.info).toHaveProperty('title', 'SovEcom API');
        expect(res.body).toHaveProperty('paths');
        expect(res.body.paths).toHaveProperty('/health');
      });
  });

  it('GET /admin/v1/docs should return Swagger UI HTML', () => {
    return request(app.getHttpServer())
      .get('/admin/v1/docs')
      .expect(200)
      .expect('Content-Type', /text\/html/)
      .expect((res) => {
        expect(res.text).toContain('swagger');
      });
  });
});
