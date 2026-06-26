/**
 * the store theme controller piggybacks analytics config onto
 * `GET /store/v1/theme` so the storefront layout's existing fetch carries the Plausible/GA4/Meta ids.
 * Unit-level: mocks the collaborators; pins (a) analytics merged onto a present theme, (b) null theme
 * stays null, (c) rate-limit 429.
 */
import { HttpException } from '@nestjs/common';
import type { Request } from 'express';
import { ThemesStoreController } from './themes.controller.store';
import type { ThemesService } from './themes.service';
import type { StoreTenantService } from '../catalog/store-tenant.service';
import type { RateLimitService } from '../auth/services/rate-limit.service';
import type { TenantSettingsService, AnalyticsSettings } from '../taxes/tenant-settings.service';

const ANALYTICS: AnalyticsSettings = {
  plausibleDomain: 'shop.example.com',
  ga4Id: 'G-ABC123',
  metaPixelId: null,
};

function makeController(opts: {
  active: Awaited<ReturnType<ThemesService['getActive']>>;
  allowed?: boolean;
}) {
  const themes = {
    getActive: jest.fn().mockResolvedValue(opts.active),
  } as unknown as ThemesService;
  const storeTenant = {
    getDefaultTenantId: jest.fn().mockResolvedValue('tenant-1'),
  } as unknown as StoreTenantService;
  const rateLimit = {
    check: jest.fn().mockResolvedValue({ allowed: opts.allowed ?? true }),
  } as unknown as RateLimitService;
  const settings = {
    getAnalyticsSettings: jest.fn().mockResolvedValue(ANALYTICS),
  } as unknown as TenantSettingsService;
  return {
    controller: new ThemesStoreController(themes, storeTenant, rateLimit, settings),
    settings,
  };
}

const req = { ip: '1.2.3.4' } as Request;

describe('ThemesStoreController (analytics piggyback)', () => {
  it('merges analytics onto a present active theme', async () => {
    const { controller } = makeController({
      active: { name: 'default', version: '1.0.0', settings: { primary: '#000' } },
    });
    const res = await controller.active(req);
    expect(res).toEqual({
      name: 'default',
      version: '1.0.0',
      settings: { primary: '#000' },
      analytics: ANALYTICS,
    });
  });

  it('omits the analytics key entirely when nothing is configured (no public state leak)', async () => {
    const themes = {
      getActive: jest.fn().mockResolvedValue({ name: 'default', version: '1.0.0', settings: {} }),
    } as unknown as ThemesService;
    const storeTenant = {
      getDefaultTenantId: jest.fn().mockResolvedValue('t1'),
    } as unknown as StoreTenantService;
    const rateLimit = {
      check: jest.fn().mockResolvedValue({ allowed: true }),
    } as unknown as RateLimitService;
    const settings = {
      getAnalyticsSettings: jest
        .fn()
        .mockResolvedValue({ plausibleDomain: null, ga4Id: null, metaPixelId: null }),
    } as unknown as TenantSettingsService;
    const controller = new ThemesStoreController(themes, storeTenant, rateLimit, settings);
    const res = await controller.active(req);
    expect(res).not.toHaveProperty('analytics');
  });

  it('returns null (and never reads analytics) when no theme is active', async () => {
    const { controller, settings } = makeController({ active: null });
    expect(await controller.active(req)).toBeNull();
    expect(settings.getAnalyticsSettings).not.toHaveBeenCalled();
  });

  it('throws 429 when rate-limited', async () => {
    const { controller } = makeController({
      active: { name: 'default', version: '1.0.0', settings: {} },
      allowed: false,
    });
    await expect(controller.active(req)).rejects.toBeInstanceOf(HttpException);
  });
});
