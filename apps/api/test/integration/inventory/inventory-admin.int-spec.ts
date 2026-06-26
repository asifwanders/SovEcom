/**
 * Admin inventory-reservations debug endpoint.
 *
 * GET /admin/v1/inventory/reservations — gated by ORDERS_READ. Returns the
 * caller-tenant's reservations, optionally filtered by ?variantId=.
 */
import request from 'supertest';
import { InventoryService } from '../../../src/inventory/inventory.service';
import {
  bootInventoryApp,
  resetInventoryState,
  seedVariant,
  seedCart,
  seedAndLoginAdmin,
  InventoryHarness,
  DEFAULT_TENANT_ID,
} from './_inventory-harness';

let h: InventoryHarness;
let inventory: InventoryService;

beforeAll(async () => {
  h = await bootInventoryApp();
  inventory = h.app.get(InventoryService);
}, 30_000);

afterAll(async () => {
  await h.app.close();
  await h.client.end();
});

beforeEach(async () => {
  await resetInventoryState(h);
}, 10_000);

const T = DEFAULT_TENANT_ID;
const URL = '/admin/v1/inventory/reservations';

describe('GET /admin/v1/inventory/reservations', () => {
  it('returns the tenant reservations for an admin with ORDERS_READ', async () => {
    const { variantId } = await seedVariant(h, { stock: 10 });
    const cartId = await seedCart(h);
    await inventory.reserve(T, cartId, variantId, 3);

    const admin = await seedAndLoginAdmin(h, { role: 'admin' });
    const res = await request(h.http()).get(URL).set('Authorization', admin.bearer);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.reservations)).toBe(true);
    expect(res.body.reservations).toHaveLength(1);
    expect(res.body.reservations[0]).toMatchObject({
      variantId,
      cartId,
      quantity: 3,
      status: 'reserved',
    });
  });

  it('filters by ?variantId=', async () => {
    const a = await seedVariant(h, { stock: 10 });
    const b = await seedVariant(h, { stock: 10 });
    const cartId = await seedCart(h);
    await inventory.reserve(T, cartId, a.variantId, 1);
    await inventory.reserve(T, cartId, b.variantId, 2);

    const admin = await seedAndLoginAdmin(h, { role: 'admin' });
    const res = await request(h.http())
      .get(URL)
      .query({ variantId: a.variantId })
      .set('Authorization', admin.bearer);
    expect(res.status).toBe(200);
    expect(res.body.reservations).toHaveLength(1);
    expect(res.body.reservations[0].variantId).toBe(a.variantId);
  });

  it('rejects an unauthenticated request with 401 (guard is active)', async () => {
    const res = await request(h.http()).get(URL);
    expect(res.status).toBe(401);
  });

  it('staff (who DO carry orders:read in the role map) are allowed', async () => {
    // The 403-on-missing-permission branch is exhaustively proven by the
    // authorization matrix suite; here we assert the chosen permission grants
    // access to a role that holds it, confirming the route is permission-gated
    // (not @Public / fail-closed-denied).
    const staff = await seedAndLoginAdmin(h, { role: 'staff' });
    const res = await request(h.http()).get(URL).set('Authorization', staff.bearer);
    expect(res.status).toBe(200);
  });
});
