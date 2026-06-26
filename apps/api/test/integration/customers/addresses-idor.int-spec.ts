/**
 * Address CRUD (self-scoped) + IDOR isolation (SECURITY-CRITICAL).
 * Customer A can never read/patch/delete customer B's address.
 */
import request from 'supertest';
import {
  bootCustomersApp,
  teardownCustomersApp,
  resetCustomersState,
  signupAndLogin,
  STORE,
  CustomersHarness,
} from './_customers-harness';

const ADDR = {
  type: 'shipping' as const,
  name: 'Alice',
  line1: '1 Rue de Test',
  city: 'Paris',
  postalCode: '75001',
  country: 'FR',
};

describe('Addresses CRUD + IDOR (integration, SECURITY-CRITICAL)', () => {
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

  it('a customer can create/list/update/delete their own addresses', async () => {
    const a = await signupAndLogin(h);
    const create = await request(h.http())
      .post(STORE.addresses)
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ ...ADDR, isDefault: true });
    expect(create.status).toBe(201);
    const id = create.body.id as string;
    expect(create.body.isDefault).toBe(true);
    expect(create.body.country).toBe('FR');

    const list = await request(h.http())
      .get(STORE.addresses)
      .set('Authorization', `Bearer ${a.accessToken}`);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);

    const patch = await request(h.http())
      .patch(`${STORE.addresses}/${id}`)
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ city: 'Lyon' });
    expect(patch.status).toBe(200);
    expect(patch.body.city).toBe('Lyon');

    const del = await request(h.http())
      .delete(`${STORE.addresses}/${id}`)
      .set('Authorization', `Bearer ${a.accessToken}`);
    expect(del.status).toBe(204);
  });

  it('setting a new default clears the previous default of the same type', async () => {
    const a = await signupAndLogin(h);
    const first = await request(h.http())
      .post(STORE.addresses)
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ ...ADDR, isDefault: true });
    const second = await request(h.http())
      .post(STORE.addresses)
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ ...ADDR, name: 'Alice 2', isDefault: true });
    expect(second.body.isDefault).toBe(true);

    const list = await request(h.http())
      .get(STORE.addresses)
      .set('Authorization', `Bearer ${a.accessToken}`);
    const defaults = (list.body as Array<{ id: string; isDefault: boolean }>).filter(
      (x) => x.isDefault,
    );
    expect(defaults).toHaveLength(1);
    expect(defaults[0]!.id).toBe(second.body.id);
    expect(first.body.id).not.toBe(second.body.id);
  });

  it('IDOR: customer A cannot read/patch/delete customer B address (404)', async () => {
    const a = await signupAndLogin(h);
    const b = await signupAndLogin(h);
    const bAddr = await request(h.http())
      .post(STORE.addresses)
      .set('Authorization', `Bearer ${b.accessToken}`)
      .send(ADDR);
    expect(bAddr.status).toBe(201);
    const bId = bAddr.body.id as string;

    // A's address list must NOT contain B's address.
    const aList = await request(h.http())
      .get(STORE.addresses)
      .set('Authorization', `Bearer ${a.accessToken}`);
    expect(aList.body).toHaveLength(0);

    // A patching B's address id → 404 (scoped to A's customer_id).
    const patch = await request(h.http())
      .patch(`${STORE.addresses}/${bId}`)
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ city: 'Hacked' });
    expect(patch.status).toBe(404);

    // A deleting B's address id → 404.
    const del = await request(h.http())
      .delete(`${STORE.addresses}/${bId}`)
      .set('Authorization', `Bearer ${a.accessToken}`);
    expect(del.status).toBe(404);

    // B's address is untouched.
    const bList = await request(h.http())
      .get(STORE.addresses)
      .set('Authorization', `Bearer ${b.accessToken}`);
    expect(bList.body).toHaveLength(1);
    expect((bList.body as Array<{ city: string }>)[0]!.city).toBe('Paris');
  });

  it('IDOR: customer A cannot read customer B profile via /me (own only)', async () => {
    const a = await signupAndLogin(h);
    const b = await signupAndLogin(h);
    const meA = await request(h.http())
      .get(STORE.me)
      .set('Authorization', `Bearer ${a.accessToken}`);
    expect(meA.body.email).toBe(a.email);
    expect(meA.body.email).not.toBe(b.email);
  });
});
