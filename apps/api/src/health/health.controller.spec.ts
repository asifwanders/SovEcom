import { Test, TestingModule } from '@nestjs/testing';
import { ServiceUnavailableException } from '@nestjs/common';
import { HealthController } from './health.controller';
import { HealthService, HealthCheckResult } from './health.service';

describe('HealthController', () => {
  async function build(result: HealthCheckResult): Promise<HealthController> {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: HealthService, useValue: { check: jest.fn().mockResolvedValue(result) } },
      ],
    }).compile();
    return module.get<HealthController>(HealthController);
  }

  it('returns the health result when everything is ok', async () => {
    const result: HealthCheckResult = {
      status: 'ok',
      uptime: 1,
      postgres: 'ok',
      redis: 'ok',
      meilisearch: 'ok',
      storage: 'ok',
    };
    expect(await (await build(result)).check()).toEqual(result);
  });

  it('throws 503 (ServiceUnavailable) with the detail when a subsystem is down', async () => {
    const result: HealthCheckResult = {
      status: 'error',
      uptime: 1,
      postgres: 'ok',
      redis: 'down',
      meilisearch: 'ok',
      storage: 'ok',
    };
    const controller = await build(result);
    await expect(controller.check()).rejects.toBeInstanceOf(ServiceUnavailableException);
    await controller.check().catch((err: ServiceUnavailableException) => {
      expect(err.getResponse()).toMatchObject({ status: 'error', redis: 'down' });
    });
  });
});
