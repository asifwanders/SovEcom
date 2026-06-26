/**
 * Admin customer CRUD: RBAC per role + tenant isolation
 * (SECURITY-CRITICAL).
 */
import request from 'supertest';
import {
  bootCustomersApp,
  teardownCustomersApp,
  resetCustomersState,
  seedAdmin,
  adminLogin,
  signupAndLogin,
  makeTenant,
  setDefaultTenant,
  newId,
  uniqEmail,
  DEFAULT_TENANT_ID,
  ADMIN,
  CustomersHarness,
} from './_customers-harness';

describe('Admin customers RBAC + tenant isolation (integration, SECURITY-CRITICAL)', () => {
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

  it('admin can create, list and get a customer', async () => {
    const admin = await seedAdmin(h, { tenantId: DEFAULT_TENANT_ID, role: 'admin' });
    const token = await adminLogin(h, admin);
    const email = uniqEmail();
    const create = await request(h.http())
      .post(ADMIN.customers)
      .set('Authorization', `Bearer ${token}`)
      .send({ email, name: 'B2B Co', isB2b: true });
    expect(create.status).toBe(201);
    expect(create.body.email).toBe(email);
    expect(create.body).not.toHaveProperty('passwordHash');

    const list = await request(h.http())
      .get(ADMIN.customers)
      .set('Authorization', `Bearer ${token}`);
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(1);

    const get = await request(h.http())
      .get(`${ADMIN.customers}/${create.body.id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(get.status).toBe(200);
    expect(get.body.id).toBe(create.body.id);
  });

  it('staff (customers:read only): GET ok, but POST/PATCH/DELETE → 403', async () => {
    const staff = await seedAdmin(h, { tenantId: DEFAULT_TENANT_ID, role: 'staff' });
    const token = await adminLogin(h, staff);

    const list = await request(h.http())
      .get(ADMIN.customers)
      .set('Authorization', `Bearer ${token}`);
    expect(list.status).toBe(200);

    const create = await request(h.http())
      .post(ADMIN.customers)
      .set('Authorization', `Bearer ${token}`)
      .send({ email: uniqEmail() });
    expect(create.status).toBe(403);

    // Seed a customer to attempt patch/delete on.
    const cust = await signupAndLogin(h);
    const patch = await request(h.http())
      .patch(`${ADMIN.customers}/${cust.customerId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'X' });
    expect(patch.status).toBe(403);
    const del = await request(h.http())
      .delete(`${ADMIN.customers}/${cust.customerId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(del.status).toBe(403);
  });

  it('owner can erase (customers:delete) with a matching confirmEmail echo', async () => {
    const owner = await seedAdmin(h, { tenantId: DEFAULT_TENANT_ID, role: 'owner' });
    const token = await adminLogin(h, owner);
    const cust = await signupAndLogin(h);
    const del = await request(h.http())
      .delete(`${ADMIN.customers}/${cust.customerId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ confirmEmail: cust.email });
    expect(del.status).toBe(204);
  });

  it('unauthenticated → 401', async () => {
    const res = await request(h.http()).get(ADMIN.customers);
    expect(res.status).toBe(401);
  });

  it('tenant isolation: tenant-A admin cannot see tenant-B customer (404)', async () => {
    // Default tenant (A) admin.
    const adminA = await seedAdmin(h, { tenantId: DEFAULT_TENANT_ID, role: 'admin' });

    // Tenant B with its own customer, inserted directly.
    const tenantB = await makeTenant(h, 'tenant-b');
    const custBId = newId();
    await h.client`
      insert into customers (id, tenant_id, email, name)
      values (${custBId}, ${tenantB}, ${uniqEmail()}, ${'B Customer'})
    `;

    // Admin A logs in against the DEFAULT tenant (re-point cache to A first).
    await setDefaultTenant(h, DEFAULT_TENANT_ID);
    const tokenA = await adminLogin(h, adminA);

    const get = await request(h.http())
      .get(`${ADMIN.customers}/${custBId}`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(get.status).toBe(404);

    // And B's customer is absent from A's list.
    const list = await request(h.http())
      .get(ADMIN.customers)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(list.status).toBe(200);
    const emails = (list.body.data as Array<{ id: string }>).map((c) => c.id);
    expect(emails).not.toContain(custBId);
  });
});
