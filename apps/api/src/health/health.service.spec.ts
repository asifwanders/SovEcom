import { Test, TestingModule } from '@nestjs/testing';
import { HealthService } from './health.service';
import { DatabaseService } from '../database/database.service';
import { RedisService } from '../redis/redis.service';
import { SearchService } from '../search/search.service';
import { StorageService } from '../storage/storage.service';

async function build(pg: boolean, rd: boolean, ms: boolean, st = true): Promise<HealthService> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      HealthService,
      { provide: DatabaseService, useValue: { ping: jest.fn().mockResolvedValue(pg) } },
      { provide: RedisService, useValue: { ping: jest.fn().mockResolvedValue(rd) } },
      { provide: SearchService, useValue: { ping: jest.fn().mockResolvedValue(ms) } },
      {
        provide: StorageService,
        useValue: {
          healthProbe: jest.fn().mockResolvedValue({ ok: st, latencyMs: 1 }),
        },
      },
    ],
  }).compile();
  return module.get<HealthService>(HealthService);
}

describe('HealthService', () => {
  it('reports ok when every subsystem is up', async () => {
    const result = await (await build(true, true, true)).check();
    expect(result).toMatchObject({
      status: 'ok',
      postgres: 'ok',
      redis: 'ok',
      meilisearch: 'ok',
      storage: 'ok',
    });
    expect(typeof result.uptime).toBe('number');
    expect(result.uptime).toBeGreaterThanOrEqual(0);
  });

  it('reports error and flags the down subsystem when one is down', async () => {
    const result = await (await build(true, false, true)).check();
    expect(result.status).toBe('error');
    expect(result.redis).toBe('down');
    expect(result.postgres).toBe('ok');
    expect(result.meilisearch).toBe('ok');
    expect(result.storage).toBe('ok');
  });

  it('reports error when all subsystems are down', async () => {
    const result = await (await build(false, false, false, false)).check();
    expect(result.status).toBe('error');
    expect(result.postgres).toBe('down');
    expect(result.redis).toBe('down');
    expect(result.meilisearch).toBe('down');
    expect(result.storage).toBe('down');
  });
});
