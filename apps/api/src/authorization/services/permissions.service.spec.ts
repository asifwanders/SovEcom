/**
 * PermissionsService unit tests.
 * Pure role→permission matrix; no Nest, no DB.
 */
import { PermissionsService } from './permissions.service';
import { PERMISSIONS, ALL_PERMISSIONS } from '../permissions.constants';

describe('PermissionsService (unit)', () => {
  const svc = new PermissionsService();

  it('owner and admin hold EVERY permission', () => {
    for (const p of ALL_PERMISSIONS) {
      expect(svc.hasPermission('owner', p)).toBe(true);
      expect(svc.hasPermission('admin', p)).toBe(true);
    }
    expect(svc.permissionsFor('owner').size).toBe(ALL_PERMISSIONS.length);
    expect(svc.permissionsFor('admin').size).toBe(ALL_PERMISSIONS.length);
  });

  it('owner and admin hold the module install/registry permissions', () => {
    for (const role of ['owner', 'admin'] as const) {
      expect(svc.hasPermission(role, PERMISSIONS.MODULES_READ)).toBe(true);
      expect(svc.hasPermission(role, PERMISSIONS.MODULES_WRITE)).toBe(true);
    }
  });

  it('owner and admin hold the theme install/registry permissions', () => {
    for (const role of ['owner', 'admin'] as const) {
      expect(svc.hasPermission(role, PERMISSIONS.THEMES_READ)).toBe(true);
      expect(svc.hasPermission(role, PERMISSIONS.THEMES_WRITE)).toBe(true);
    }
  });

  it('owner and admin hold the CMS-lite pages permissions', () => {
    for (const role of ['owner', 'admin'] as const) {
      expect(svc.hasPermission(role, PERMISSIONS.PAGES_READ)).toBe(true);
      expect(svc.hasPermission(role, PERMISSIONS.PAGES_WRITE)).toBe(true);
      expect(svc.hasPermission(role, PERMISSIONS.PAGES_DELETE)).toBe(true);
    }
  });

  it('staff holds exactly the operational subset', () => {
    const expected = [
      PERMISSIONS.PRODUCTS_READ,
      PERMISSIONS.PRODUCTS_WRITE,
      PERMISSIONS.CATEGORIES_READ,
      PERMISSIONS.CATEGORIES_WRITE,
      // Pages read/write mirror categories read/write.
      PERMISSIONS.PAGES_READ,
      PERMISSIONS.PAGES_WRITE,
      PERMISSIONS.CUSTOMERS_READ,
      PERMISSIONS.ORDERS_READ,
      PERMISSIONS.AUDIT_LOG_READ,
      // Dashboard stats: staff can VIEW the dashboard (operational read).
      PERMISSIONS.DASHBOARD_READ,
    ];
    for (const p of expected) {
      expect(svc.hasPermission('staff', p)).toBe(true);
    }
    expect(svc.permissionsFor('staff').size).toBe(expected.length);
  });

  it('staff is DENIED every destructive / privileged permission', () => {
    for (const p of [
      PERMISSIONS.PRODUCTS_DELETE,
      PERMISSIONS.CATEGORIES_DELETE,
      // Pages: staff can read/write content but not DELETE (mirrors categories).
      PERMISSIONS.PAGES_DELETE,
      PERMISSIONS.CUSTOMERS_WRITE,
      PERMISSIONS.CUSTOMERS_DELETE,
      // orders:write is admin+ — staff READ orders but cannot transition/mark-paid.
      PERMISSIONS.ORDERS_WRITE,
      PERMISSIONS.ORDERS_REFUND,
      PERMISSIONS.SETTINGS_READ,
      PERMISSIONS.SETTINGS_WRITE,
      PERMISSIONS.USERS_READ,
      PERMISSIONS.USERS_WRITE,
      PERMISSIONS.USERS_DELETE,
      // Modules: staff can neither read the registry nor install.
      PERMISSIONS.MODULES_READ,
      PERMISSIONS.MODULES_WRITE,
      // Themes: staff can neither read the registry nor install/activate.
      PERMISSIONS.THEMES_READ,
      PERMISSIONS.THEMES_WRITE,
    ]) {
      expect(svc.hasPermission('staff', p)).toBe(false);
    }
  });

  it('an unknown / empty role holds NOTHING (fail-closed)', () => {
    expect(svc.hasPermission('root', PERMISSIONS.PRODUCTS_READ)).toBe(false);
    expect(svc.hasPermission('', PERMISSIONS.PRODUCTS_READ)).toBe(false);
    expect(svc.hasPermission('Admin', PERMISSIONS.PRODUCTS_READ)).toBe(false); // case-sensitive
    expect(svc.permissionsFor('nope').size).toBe(0);
  });

  it('prototype-chain role strings resolve to deny, never throw', () => {
    for (const role of ['__proto__', 'constructor', 'hasOwnProperty', 'toString']) {
      expect(() => svc.hasPermission(role, PERMISSIONS.PRODUCTS_READ)).not.toThrow();
      expect(svc.hasPermission(role, PERMISSIONS.PRODUCTS_READ)).toBe(false);
      expect(svc.permissionsFor(role).size).toBe(0);
    }
  });
});
