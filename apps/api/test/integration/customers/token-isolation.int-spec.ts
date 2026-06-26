/**
 * Token isolation between the two auth systems (SECURITY-CRITICAL).
 * A customer token must NEVER reach an admin route, and an admin token must
 * NEVER act as a customer. Both guards pin `purpose` (verified, not trusted)
 * even though both kinds are signed with the same JWT_SECRET.
 */
import request from 'supertest';
import {
  bootCustomersApp,
  teardownCustomersApp,
  resetCustomersState,
  signupAndLogin,
  seedAdmin,
  adminLogin,
  adminLoginWithCookie,
  countLiveRefresh,
  rawTokenFromCookie,
  ADMIN_REFRESH_COOKIE,
  CUSTOMER_REFRESH_COOKIE,
  DEFAULT_TENANT_ID,
  ADMIN,
  STORE,
  CustomersHarness,
} from './_customers-harness';

describe('Cross-auth token isolation (integration, SECURITY-CRITICAL)', () => {
  let h: CustomersHarness;
  beforeAll(async () => {
    h = await bootCustomersApp();
  });
  afterAll(async () => {
    await teardownCustomersApp(h);
  });
  beforeEach(async () => {
    await resetCustomersState(h);
  });

  it('a CUSTOMER access token is rejected (401) on an admin route', async () => {
    const customer = await signupAndLogin(h);
    const res = await request(h.http())
      .get(ADMIN.customers)
      .set('Authorization', `Bearer ${customer.accessToken}`);
    // The global admin JwtAuthGuard pins purpose:'access' and rejects 'customer'.
    expect(res.status).toBe(401);
  });

  it('a CUSTOMER token is rejected on /admin/v1/products too', async () => {
    const customer = await signupAndLogin(h);
    const res = await request(h.http())
      .get(ADMIN.products)
      .set('Authorization', `Bearer ${customer.accessToken}`);
    expect(res.status).toBe(401);
  });

  it('an ADMIN access token is rejected (401) on /store/v1/customers/me', async () => {
    const admin = await seedAdmin(h, { tenantId: DEFAULT_TENANT_ID });
    const adminToken = await adminLogin(h, admin);
    expect(typeof adminToken).toBe('string');
    const res = await request(h.http()).get(STORE.me).set('Authorization', `Bearer ${adminToken}`);
    // The CustomerAuthGuard pins purpose:'customer' and rejects 'access'.
    expect(res.status).toBe(401);
  });

  it('each token works on its OWN surface (control)', async () => {
    const admin = await seedAdmin(h, { tenantId: DEFAULT_TENANT_ID });
    const adminToken = await adminLogin(h, admin);
    const customer = await signupAndLogin(h);

    const adminOk = await request(h.http())
      .get(ADMIN.customers)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(adminOk.status).toBe(200);

    const custOk = await request(h.http())
      .get(STORE.me)
      .set('Authorization', `Bearer ${customer.accessToken}`);
    expect(custOk.status).toBe(200);
  });

  // ── F3: cross-system REFRESH-TOKEN isolation (real bug fixed) ────────────────

  it('a CUSTOMER refresh token at the ADMIN refresh endpoint → 401 and does NOT touch the customer family', async () => {
    const customer = await signupAndLogin(h);
    expect(await countLiveRefresh(h, customer.customerId)).toBe(1);
    const custRaw = rawTokenFromCookie(customer.refreshCookie);

    // Present the customer's raw token at the admin endpoint under the ADMIN cookie
    // name. The admin refresh is now scoped to user_id NOT NULL, so it must neither
    // claim nor revoke this customer-owned row.
    const res = await request(h.http())
      .post(ADMIN.refresh)
      .set('Cookie', `${ADMIN_REFRESH_COOKIE}=${custRaw}`);
    expect(res.status).toBe(401);

    // The customer's family is untouched — still exactly one live row...
    expect(await countLiveRefresh(h, customer.customerId)).toBe(1);
    // ...and the customer can still rotate normally (no reuse-detection tripped).
    const stillWorks = await request(h.http())
      .post(STORE.refresh)
      .set('Cookie', customer.refreshCookie);
    expect(stillWorks.status).toBe(200);
  });

  it('an ADMIN refresh token at the CUSTOMER refresh endpoint → 401 and does NOT touch the admin family', async () => {
    const admin = await seedAdmin(h, { tenantId: DEFAULT_TENANT_ID });
    const adminSession = await adminLoginWithCookie(h, admin);
    const adminRaw = rawTokenFromCookie(adminSession.refreshCookie);

    const liveAdminBefore = await h.client<{ c: string }[]>`
      select count(*)::int as c from refresh_tokens
      where user_id = ${admin.id} and revoked_at is null`;
    expect(Number(liveAdminBefore[0]!.c)).toBe(1);

    // Present the admin's raw token at the customer endpoint under the CUSTOMER
    // cookie name. The customer refresh is scoped to customer_id NOT NULL → no-op.
    const res = await request(h.http())
      .post(STORE.refresh)
      .set('Cookie', `${CUSTOMER_REFRESH_COOKIE}=${adminRaw}`);
    expect(res.status).toBe(401);

    // The admin family is untouched — still rotatable on the admin surface.
    const liveAdminAfter = await h.client<{ c: string }[]>`
      select count(*)::int as c from refresh_tokens
      where user_id = ${admin.id} and revoked_at is null`;
    expect(Number(liveAdminAfter[0]!.c)).toBe(1);
    const stillWorks = await request(h.http())
      .post(ADMIN.refresh)
      .set('Cookie', adminSession.refreshCookie);
    expect(stillWorks.status).toBe(200);
  });
});
