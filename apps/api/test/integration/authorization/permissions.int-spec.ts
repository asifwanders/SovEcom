/**
 * Authorization / RBAC access matrix (integration,
 * SECURITY-CRITICAL). Decisions 023.3/.4/.5/.6. Real Postgres + Redis, full Nest.
 *
 * A TEST-ONLY controller (mounted in the harness, never in AppModule) declares
 * permission-gated routes; the real global JwtAuthGuard + PermissionsGuard apply.
 * Asserted:
 *   - each role reaches its allowed routes and is 403'd on the rest;
 *   - `@AnyAuthenticated` routes are open to any logged-in role, 401 without auth;
 *   - `@Public` routes need no token (the PermissionsGuard does not block them);
 *   - a protected route declaring NEITHER marker is 403 for everyone (fail-closed);
 *   - unauthenticated requests are 401 (JwtAuthGuard), never 403;
 *   - every denial writes an `authz.permission.denied` audit row (no secret).
 */
import request from 'supertest';
import { Controller, Get } from '@nestjs/common';
import {
  bootAuthApp,
  teardownAuthApp,
  resetAuthState,
  seedAdmin,
  auditRows,
  AuthHarness,
} from '../auth/_auth-harness';
import { RequirePermission } from '../../../src/authorization/decorators/require-permission.decorator';
import { AnyAuthenticated } from '../../../src/authorization/decorators/any-authenticated.decorator';
import { Public } from '../../../src/auth/decorators/public.decorator';
import { PERMISSIONS } from '../../../src/authorization/permissions.constants';

/** Test-only surface exercising every guard branch. Not part of AppModule. */
@Controller('test-authz')
class TestAuthzController {
  @RequirePermission(PERMISSIONS.PRODUCTS_READ)
  @Get('products-read')
  productsRead(): { ok: true } {
    return { ok: true };
  }

  @RequirePermission(PERMISSIONS.PRODUCTS_DELETE)
  @Get('products-delete')
  productsDelete(): { ok: true } {
    return { ok: true };
  }

  @RequirePermission(PERMISSIONS.ORDERS_REFUND)
  @Get('orders-refund')
  ordersRefund(): { ok: true } {
    return { ok: true };
  }

  @RequirePermission(PERMISSIONS.SETTINGS_READ)
  @Get('settings-read')
  settingsRead(): { ok: true } {
    return { ok: true };
  }

  @AnyAuthenticated()
  @Get('any')
  any(): { ok: true } {
    return { ok: true };
  }

  @Public()
  @Get('public')
  pub(): { ok: true } {
    return { ok: true };
  }

  // Intentionally NO marker -> must be denied (fail-closed) even when authenticated.
  @Get('undeclared')
  undeclared(): { ok: true } {
    return { ok: true };
  }
}

/**
 * Class-level `@AnyAuthenticated()` with a stricter method-level
 * `@RequirePermission` — exercises the strict-marker-wins precedence (a class
 * marker must NOT silently open a permissioned handler).
 */
@AnyAuthenticated()
@Controller('test-authz-precedence')
class TestPrecedenceController {
  @RequirePermission(PERMISSIONS.PRODUCTS_DELETE)
  @Get('delete-gated')
  deleteGated(): { ok: true } {
    return { ok: true };
  }

  @Get('class-only')
  classOnly(): { ok: true } {
    return { ok: true };
  }
}

/** `@Public` + `@RequirePermission` on the same route — a misconfiguration. */
@Controller('test-authz-misconfig')
class TestMisconfigController {
  @Public()
  @RequirePermission(PERMISSIONS.PRODUCTS_READ)
  @Get('public-and-perm')
  publicAndPerm(): { ok: true } {
    return { ok: true };
  }
}

const URL = (p: string): string => `/test-authz/${p}`;

describe('A7 authorization / RBAC matrix (integration, SECURITY-CRITICAL)', () => {
  let h: AuthHarness;
  beforeAll(async () => {
    h = await bootAuthApp({
      controllers: [TestAuthzController, TestPrecedenceController, TestMisconfigController],
    });
  });
  afterAll(async () => {
    await teardownAuthApp(h);
  });
  beforeEach(async () => {
    await resetAuthState(h);
  });

  /** Log a seeded (non-2FA) user in and return the bearer header. */
  async function bearerFor(email: string, password: string): Promise<string> {
    const res = await request(h.http())
      .post('/admin/v1/auth/login')
      .send({ email, password })
      .expect(200);
    return `Bearer ${res.body.accessToken}`;
  }

  it('admin reaches every permissioned route; staff only its subset', async () => {
    const admin = await seedAdmin(h, { role: 'admin' });
    const staff = await seedAdmin(h, {
      role: 'staff',
      tenantId: admin.tenantId,
      email: 'staff@x.test',
    });
    const adminAuth = await bearerFor(admin.email, admin.password);
    const staffAuth = await bearerFor(staff.email, staff.password);

    // admin (all permissions)
    await request(h.http()).get(URL('products-read')).set('Authorization', adminAuth).expect(200);
    await request(h.http()).get(URL('products-delete')).set('Authorization', adminAuth).expect(200);
    await request(h.http()).get(URL('orders-refund')).set('Authorization', adminAuth).expect(200);
    await request(h.http()).get(URL('settings-read')).set('Authorization', adminAuth).expect(200);

    // staff: holds products:read, denied delete/refund/settings
    await request(h.http()).get(URL('products-read')).set('Authorization', staffAuth).expect(200);
    await request(h.http()).get(URL('products-delete')).set('Authorization', staffAuth).expect(403);
    await request(h.http()).get(URL('orders-refund')).set('Authorization', staffAuth).expect(403);
    await request(h.http()).get(URL('settings-read')).set('Authorization', staffAuth).expect(403);
  });

  it('owner reaches everything (super-account)', async () => {
    const owner = await seedAdmin(h, { role: 'owner' });
    const auth = await bearerFor(owner.email, owner.password);
    await request(h.http()).get(URL('products-delete')).set('Authorization', auth).expect(200);
    await request(h.http()).get(URL('orders-refund')).set('Authorization', auth).expect(200);
    await request(h.http()).get(URL('settings-read')).set('Authorization', auth).expect(200);
  });

  it('@AnyAuthenticated is open to any role but needs a token', async () => {
    const staff = await seedAdmin(h, { role: 'staff' });
    const auth = await bearerFor(staff.email, staff.password);
    await request(h.http()).get(URL('any')).set('Authorization', auth).expect(200);
    // no token -> 401 from JwtAuthGuard (NOT 403)
    await request(h.http()).get(URL('any')).expect(401);
  });

  it('@Public routes are reachable without a token (guard does not block them)', async () => {
    await request(h.http()).get(URL('public')).expect(200);
  });

  it('FAIL-CLOSED: an authenticated route with NO permission marker is 403 for everyone', async () => {
    const admin = await seedAdmin(h, { role: 'admin' });
    const auth = await bearerFor(admin.email, admin.password);
    await request(h.http()).get(URL('undeclared')).set('Authorization', auth).expect(403);
  });

  it('unauthenticated requests to permissioned routes are 401, never 403', async () => {
    await request(h.http()).get(URL('products-read')).expect(401);
    await request(h.http()).get(URL('products-delete')).expect(401);
  });

  it('the real self-service routes carry @AnyAuthenticated (staff can read /me)', async () => {
    const staff = await seedAdmin(h, { role: 'staff' });
    const auth = await bearerFor(staff.email, staff.password);
    const me = await request(h.http())
      .get('/admin/v1/auth/me')
      .set('Authorization', auth)
      .expect(200);
    expect(me.body.role).toBe('staff');
  });

  it('STRICT-MARKER-WINS: a handler @RequirePermission overrides a class @AnyAuthenticated', async () => {
    const staff = await seedAdmin(h, { role: 'staff' });
    const auth = await bearerFor(staff.email, staff.password);
    // class-level @AnyAuthenticated does NOT open the permissioned handler:
    await request(h.http())
      .get('/test-authz-precedence/delete-gated')
      .set('Authorization', auth)
      .expect(403);
    // but the handler inheriting only the class marker is open to any authenticated:
    await request(h.http())
      .get('/test-authz-precedence/class-only')
      .set('Authorization', auth)
      .expect(200);
  });

  it('@Public + @RequirePermission is a misconfiguration -> denied (never open)', async () => {
    await request(h.http()).get('/test-authz-misconfig/public-and-perm').expect(403);
  });

  it('every denial writes an audit row (actor + required permission + role, no secret)', async () => {
    const staff = await seedAdmin(h, { role: 'staff', password: 'super-secret-pw-1234' });
    const auth = await bearerFor(staff.email, staff.password);
    await request(h.http()).get(URL('orders-refund')).set('Authorization', auth).expect(403);

    const rows = await auditRows(h, 'authz.permission.denied');
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const row = rows[0];
    expect(row.actor_type).toBe('user');
    expect(row.actor_id).toBe(staff.id);
    const changes = JSON.stringify(row.changes ?? {});
    expect(changes).toContain('orders:refund');
    expect(changes).toContain('staff');
    // No credential ever lands in the audit trail.
    const blob = JSON.stringify(row);
    expect(blob).not.toContain('super-secret-pw-1234');
  });
});
