/**
 * HomeSectionsAdminController unit tests.
 *
 * Pins RBAC enforcement and @Audit decoration at the controller level:
 *   - GET /admin/v1/storefront/home-sections requires THEMES_READ.
 *   - PUT /admin/v1/storefront/home-sections requires THEMES_WRITE.
 *   - @Audit('storefront.home_sections_updated') is set on the PUT handler.
 *   - PUT with a non-array body rejects with 400 before hitting the service.
 *   - Service 422 propagates unchanged.
 *   - GET delegates to getForAdmin; PUT delegates to replace with the correct tenantId.
 */
import { BadRequestException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { HomeSectionsAdminController } from './home-sections.controller.admin';
import { HomeSectionsService } from './home-sections.service';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { PERMISSIONS } from '../authorization/permissions.constants';
import { PERMISSION_KEY } from '../authorization/decorators/require-permission.decorator';
import { AUDIT_ACTION_KEY } from '../audit/decorators/audit.decorator';
import type { HomeSectionsView } from './home-sections.service';
import type { MarketingSectionDescriptor } from '@sovecom/theme-sdk';

const TENANT = '01900000-0000-7000-8000-0000000000cc';

const VALID_HERO: MarketingSectionDescriptor = {
  type: 'hero-banner',
  settings: { headline: 'Welcome', align: 'center', overlay: false },
};

const EMPTY_VIEW: HomeSectionsView = { sections: [], updatedAt: new Date('2026-01-01') };
const HERO_VIEW: HomeSectionsView = {
  sections: [VALID_HERO],
  updatedAt: new Date('2026-01-01'),
};

function makeUser(tenantId = TENANT): AuthenticatedUser {
  return { tenantId, userId: 'user-1', role: 'admin' } as unknown as AuthenticatedUser;
}

function makeController() {
  const svc = {
    getForAdmin: jest.fn().mockResolvedValue(EMPTY_VIEW),
    replace: jest.fn().mockResolvedValue(HERO_VIEW),
  } as unknown as jest.Mocked<HomeSectionsService>;
  const controller = new HomeSectionsAdminController(svc);
  return { controller, svc };
}

describe('HomeSectionsAdminController', () => {
  // ── RBAC metadata ─────────────────────────────────────────────────────────
  // Metadata is attached to the prototype method by the decorator — access it via the prototype,
  // not a bound instance method.

  it('GET handler carries THEMES_READ RequirePermission metadata', () => {
    const reflector = new Reflector();
    const permission = reflector.get<string>(
      PERMISSION_KEY,
      HomeSectionsAdminController.prototype.get,
    );
    expect(permission).toBe(PERMISSIONS.THEMES_READ);
  });

  it('PUT handler carries THEMES_WRITE RequirePermission metadata', () => {
    const reflector = new Reflector();
    const permission = reflector.get<string>(
      PERMISSION_KEY,
      HomeSectionsAdminController.prototype.replace,
    );
    expect(permission).toBe(PERMISSIONS.THEMES_WRITE);
  });

  it('PUT handler carries @Audit metadata with the correct action', () => {
    const reflector = new Reflector();
    const action = reflector.get<string>(
      AUDIT_ACTION_KEY,
      HomeSectionsAdminController.prototype.replace,
    );
    expect(action).toBe('storefront.home_sections_updated');
  });

  // ── GET ───────────────────────────────────────────────────────────────────

  it('GET delegates to getForAdmin with the user tenantId', async () => {
    const { controller, svc } = makeController();
    const user = makeUser();
    await controller.get(user);
    expect(svc.getForAdmin).toHaveBeenCalledWith(TENANT);
  });

  it('GET returns the service result', async () => {
    const { controller, svc } = makeController();
    svc.getForAdmin.mockResolvedValue(HERO_VIEW);
    const result = await controller.get(makeUser());
    expect(result).toBe(HERO_VIEW);
  });

  // ── PUT ───────────────────────────────────────────────────────────────────

  it('PUT delegates to replace with the correct tenantId and sections array', async () => {
    const { controller, svc } = makeController();
    await controller.replace(makeUser(), { sections: [VALID_HERO] });
    expect(svc.replace).toHaveBeenCalledWith(TENANT, [VALID_HERO]);
  });

  it('PUT throws 400 when body.sections is not an array (before reaching the service)', async () => {
    const { controller, svc } = makeController();
    expect(() =>
      controller.replace(makeUser(), { sections: 'not-an-array' as unknown as unknown[] }),
    ).toThrow(BadRequestException);
    expect(svc.replace).not.toHaveBeenCalled();
  });

  it('PUT throws 400 when body.sections is an object (not an array)', async () => {
    const { controller, svc } = makeController();
    expect(() => controller.replace(makeUser(), { sections: {} as unknown as unknown[] })).toThrow(
      BadRequestException,
    );
    expect(svc.replace).not.toHaveBeenCalled();
  });

  it('PUT propagates a 422 from the service unchanged', async () => {
    const { controller, svc } = makeController();
    const { UnprocessableEntityException } = await import('@nestjs/common');
    svc.replace.mockRejectedValue(new UnprocessableEntityException('invalid section'));
    await expect(
      controller.replace(makeUser(), { sections: [{ type: 'bad', settings: {} }] }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });
});
