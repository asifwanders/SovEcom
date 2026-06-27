/**
 * HomeSectionsStoreController unit tests.
 *
 * Pins:
 *   - GET /store/v1/storefront/home-sections is public (@Public) and uses the default tenant.
 *   - Rate-limit 429 surfaces correctly.
 *   - Service response is passed through unchanged (validated sections only — corrupt ones already
 *     dropped by the service layer).
 */
import { HttpException } from '@nestjs/common';
import type { Request } from 'express';
import { HomeSectionsStoreController } from './home-sections.controller.store';
import type { HomeSectionsService } from './home-sections.service';
import type { StoreTenantService } from '../catalog/store-tenant.service';
import type { RateLimitService } from '../auth/services/rate-limit.service';
import type { HomeSectionsView } from './home-sections.service';
import type { MarketingSectionDescriptor } from '@sovecom/theme-sdk';

const VALID_HERO: MarketingSectionDescriptor = {
  type: 'hero-banner',
  settings: { headline: 'Hello', align: 'center', overlay: false },
};

const HERO_VIEW: HomeSectionsView = {
  sections: [VALID_HERO],
  updatedAt: new Date('2026-01-01'),
};

const EMPTY_VIEW: HomeSectionsView = { sections: [], updatedAt: new Date(0) };

function makeController(opts: { view?: HomeSectionsView; allowed?: boolean }) {
  const homeSections = {
    getForStore: jest.fn().mockResolvedValue(opts.view ?? EMPTY_VIEW),
  } as unknown as HomeSectionsService;
  const storeTenant = {
    getDefaultTenantId: jest.fn().mockResolvedValue('tenant-default'),
  } as unknown as StoreTenantService;
  const rateLimit = {
    check: jest.fn().mockResolvedValue({ allowed: opts.allowed ?? true }),
  } as unknown as RateLimitService;
  return {
    controller: new HomeSectionsStoreController(homeSections, storeTenant, rateLimit),
    homeSections,
    storeTenant,
    rateLimit,
  };
}

const req = { ip: '10.0.0.1' } as Request;

describe('HomeSectionsStoreController', () => {
  it('returns the sections from getForStore', async () => {
    const { controller } = makeController({ view: HERO_VIEW });
    const result = await controller.get(req);
    expect(result).toBe(HERO_VIEW);
    expect(result.sections).toHaveLength(1);
  });

  it('resolves the default tenant via StoreTenantService', async () => {
    const { controller, storeTenant, homeSections } = makeController({ view: EMPTY_VIEW });
    await controller.get(req);
    expect(storeTenant.getDefaultTenantId).toHaveBeenCalled();
    expect(homeSections.getForStore).toHaveBeenCalledWith('tenant-default');
  });

  it('returns an empty sections list when no sections have been set', async () => {
    const { controller } = makeController({ view: EMPTY_VIEW });
    const result = await controller.get(req);
    expect(result.sections).toEqual([]);
  });

  it('throws 429 when rate-limited (no service call)', async () => {
    const { controller, homeSections } = makeController({ allowed: false });
    await expect(controller.get(req)).rejects.toBeInstanceOf(HttpException);
    expect(homeSections.getForStore).not.toHaveBeenCalled();
  });

  it('uses the request IP as the rate-limit key', async () => {
    const { controller, rateLimit } = makeController({});
    await controller.get({ ip: '5.6.7.8' } as Request);
    expect(rateLimit.check).toHaveBeenCalledWith('store:5.6.7.8', expect.any(Object));
  });

  it('falls back to "unknown" for a missing request IP', async () => {
    const { controller, rateLimit } = makeController({});
    await controller.get({} as Request);
    expect(rateLimit.check).toHaveBeenCalledWith('store:unknown', expect.any(Object));
  });
});
