/**
 * admin analytics settings controller. Unit-level: GET delegates to the
 * service; PUT sanitises the body to string|null|undefined before the read-merge-write.
 */
import { BadRequestException } from '@nestjs/common';
import { AnalyticsAdminController } from './analytics.controller.admin';
import type { TenantSettingsService, AnalyticsSettings } from '../taxes/tenant-settings.service';
import type { AuthenticatedUser } from '../auth/authenticated-user';

const CURRENT: AnalyticsSettings = { plausibleDomain: 'a.com', ga4Id: null, metaPixelId: null };
const user = { tenantId: 't1' } as AuthenticatedUser;

function make() {
  const service = {
    getAnalyticsSettings: jest.fn().mockResolvedValue(CURRENT),
    updateAnalyticsSettings: jest
      .fn()
      .mockImplementation(async (_t, patch) => ({ ...CURRENT, ...patch })),
  } as unknown as TenantSettingsService;
  return { controller: new AnalyticsAdminController(service), service };
}

describe('AnalyticsAdminController', () => {
  it('GET returns the current settings', async () => {
    const { controller } = make();
    expect(await controller.get(user)).toEqual(CURRENT);
  });

  it('PUT passes through strings, clears on null/empty, ignores absent + non-string', async () => {
    const { controller, service } = make();
    await controller.update(user, {
      plausibleDomain: 'shop.example.com',
      ga4Id: '',
      metaPixelId: null,
      bogus: 123, // boundary: a non-string extra field must be dropped, not stored
    });
    expect(service.updateAnalyticsSettings).toHaveBeenCalledWith('t1', {
      plausibleDomain: 'shop.example.com',
      ga4Id: null, // '' → cleared
      metaPixelId: null,
    });
  });

  it('PUT with an empty body changes nothing (all undefined)', async () => {
    const { controller, service } = make();
    await controller.update(user, {});
    expect(service.updateAnalyticsSettings).toHaveBeenCalledWith('t1', {});
  });

  it('REJECTS enabling GA4 without rgpdAcknowledged (server-side gate)', async () => {
    const { controller, service } = make();
    await expect(controller.update(user, { ga4Id: 'G-ABC123' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(service.updateAnalyticsSettings).not.toHaveBeenCalled();
  });

  it('REJECTS enabling Meta without rgpdAcknowledged', async () => {
    const { controller, service } = make();
    await expect(controller.update(user, { metaPixelId: '123' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(service.updateAnalyticsSettings).not.toHaveBeenCalled();
  });

  it('ALLOWS enabling GA4 with rgpdAcknowledged: true', async () => {
    const { controller, service } = make();
    await controller.update(user, { ga4Id: 'G-ABC123', rgpdAcknowledged: true });
    expect(service.updateAnalyticsSettings).toHaveBeenCalledWith('t1', { ga4Id: 'G-ABC123' });
  });

  it('does NOT require acknowledgement to CLEAR a tracker or set Plausible only', async () => {
    const { controller, service } = make();
    await controller.update(user, { ga4Id: null, plausibleDomain: 'a.com' });
    expect(service.updateAnalyticsSettings).toHaveBeenCalledWith('t1', {
      ga4Id: null,
      plausibleDomain: 'a.com',
    });
  });
});
