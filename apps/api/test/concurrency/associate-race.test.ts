/**
 * Associate race — cart ownership concurrency.
 *
 * Two SIMULTANEOUS guest→customer associations for the SAME customer (two devices
 * logging in at once). The partial unique index `carts (tenant_id, customer_id)
 * WHERE status='active'` is the sole arbiter: exactly one cart adopts the customer,
 * the other merges into it. The loser never commits ownership to Redis and there is
 * never more than one active cart per customer.
 */
import {
  bootConcurrencyApp,
  teardownConcurrencyApp,
  resetConcurrencyState,
  seedVariant,
  signupAndLoginCustomer,
  runConcurrently,
  DEFAULT_TENANT_ID,
  type ConcurrencyHarness,
} from './harness';
import { ForbiddenException } from '@nestjs/common';
import type { AuthenticatedCustomer } from '../../src/customers/auth/authenticated-customer';

let h: ConcurrencyHarness;
const T = DEFAULT_TENANT_ID;

beforeAll(async () => {
  h = await bootConcurrencyApp();
}, 60_000);

afterAll(async () => {
  await teardownConcurrencyApp(h);
});

beforeEach(async () => {
  await resetConcurrencyState(h);
}, 20_000);

describe('Associate race — one active cart per customer', () => {
  it('two concurrent associates for one customer → exactly one active cart, merged, no poison', async () => {
    const { variantId: vA } = await seedVariant(h, { stock: 50, priceAmount: 1000 });
    const { variantId: vB } = await seedVariant(h, { stock: 50, priceAmount: 1000 });
    const { customerId, email } = await signupAndLoginCustomer(h);
    const customer: AuthenticatedCustomer = {
      id: customerId,
      tenantId: T,
      email,
      name: null,
      isB2b: false,
    };

    // Two guest carts, each with a distinct line.
    const cartA = await h.cart.create(T);
    await h.cart.addItem(T, cartA.id, cartA.sessionToken, undefined, vA, 1);
    const cartB = await h.cart.create(T);
    await h.cart.addItem(T, cartB.id, cartB.sessionToken, undefined, vB, 1);

    const guestCarts = [
      { id: cartA.id, token: cartA.sessionToken },
      { id: cartB.id, token: cartB.sessionToken },
    ];

    // Fire both associations simultaneously via the shared-promise barrier.
    const { fulfilled, rejected } = await runConcurrently(
      2,
      (i) => h.cart.associateCustomer(T, guestCarts[i]!.id, guestCarts[i]!.token, customer),
      'concurrent associate same customer',
    );

    // One adopts, the other merges into it — both resolve, no 500/poison.
    expect(rejected).toHaveLength(0);
    expect(fulfilled).toHaveLength(2);

    // The partial unique index holds: EXACTLY ONE active cart for the customer.
    const active = await h.client<{ id: string }[]>`
      select id from carts where tenant_id = ${T} and customer_id = ${customerId} and status = 'active'
    `;
    expect(active).toHaveLength(1);
    const winnerId = active[0]!.id;

    // The winning cart holds BOTH lines (the loser merged into it), each reserved once.
    const winner = await h.cart.findByIdAuthorised(T, winnerId, undefined, customer);
    const variants = new Set(winner.items.map((it) => it.variantId));
    expect(winner.items).toHaveLength(2);
    expect(variants.has(vA)).toBe(true);
    expect(variants.has(vB)).toBe(true);

    // Reservations: one reserved row per merged line, all on the winner.
    const reservations = await h.client<{ cart_id: string }[]>`
      select cart_id from inventory_reservations where status = 'reserved'
    `;
    expect(reservations).toHaveLength(2);
    expect(reservations.every((r) => r.cart_id === winnerId)).toBe(true);
  }, 60_000);

  it('two DIFFERENT customers racing to claim ONE shared guest cart → one wins, other rejected (no theft)', async () => {
    // Two logged-in customers presenting the SAME guest-cart cookie must NOT both
    // own/merge it — exactly one adopts; the other is rejected (403/409), never
    // silently merges a stranger's items.
    const { variantId } = await seedVariant(h, { stock: 50, priceAmount: 1000 });
    const a = await signupAndLoginCustomer(h);
    const b = await signupAndLoginCustomer(h);
    const custA: AuthenticatedCustomer = {
      id: a.customerId,
      tenantId: T,
      email: a.email,
      name: null,
      isB2b: false,
    };
    const custB: AuthenticatedCustomer = {
      id: b.customerId,
      tenantId: T,
      email: b.email,
      name: null,
      isB2b: false,
    };

    // One shared guest cart with an item; both customers present its token.
    const guest = await h.cart.create(T);
    await h.cart.addItem(T, guest.id, guest.sessionToken, undefined, variantId, 1);

    const actors = [custA, custB];
    const { fulfilled, rejected } = await runConcurrently(
      2,
      (i) => h.cart.associateCustomer(T, guest.id, guest.sessionToken, actors[i]!),
      'two customers, one shared guest cart',
    );

    // Exactly one adopts; the other is rejected (never a silent merge/theft).
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // The guest cart is owned by EXACTLY ONE of the two customers in Postgres.
    const owners = await h.client<{ customer_id: string }[]>`
      select customer_id from carts where id = ${guest.id} and status = 'active'
    `;
    expect(owners).toHaveLength(1);
    expect([a.customerId, b.customerId]).toContain(owners[0]!.customer_id);

    // The loser owns NO cart (no stranger's items pulled into a new/other cart).
    const loserId = owners[0]!.customer_id === a.customerId ? b.customerId : a.customerId;
    const loserCarts = await h.client<{ id: string }[]>`
      select id from carts where customer_id = ${loserId} and status = 'active'
    `;
    expect(loserCarts).toHaveLength(0);
  }, 60_000);

  it('a customer with their own cart cannot STEAL another customer’s already-adopted guest cart (round-3 TOCTOU)', async () => {
    const { variantId } = await seedVariant(h, { stock: 50, priceAmount: 1000 });
    const a = await signupAndLoginCustomer(h);
    const b = await signupAndLoginCustomer(h);
    const custA: AuthenticatedCustomer = {
      id: a.customerId,
      tenantId: T,
      email: a.email,
      name: null,
      isB2b: false,
    };
    const custB: AuthenticatedCustomer = {
      id: b.customerId,
      tenantId: T,
      email: b.email,
      name: null,
      isB2b: false,
    };

    // B already owns an active (empty) cart.
    const w = await h.cart.create(T);
    await h.cart.associateCustomer(T, w.id, w.sessionToken, custB);

    // Guest cart with an item; customer A adopts it FIRST.
    const guest = await h.cart.create(T);
    await h.cart.addItem(T, guest.id, guest.sessionToken, undefined, variantId, 1);
    const adopted = await h.cart.associateCustomer(T, guest.id, guest.sessionToken, custA);
    expect(adopted.customerId).toBe(a.customerId);

    // B presents the SAME guest cookie → must be REJECTED (403), NOT absorb A's cart.
    await expect(
      h.cart.associateCustomer(T, guest.id, guest.sessionToken, custB),
    ).rejects.toBeInstanceOf(ForbiddenException);

    // A still owns the guest cart with its item; B's cart is untouched (no theft).
    const stillA = await h.cart.findByIdAuthorised(T, guest.id, undefined, custA);
    expect(stillA.customerId).toBe(a.customerId);
    expect(stillA.items).toHaveLength(1);
    const wCart = await h.cart.findByIdAuthorised(T, w.id, undefined, custB);
    expect(wCart.items).toHaveLength(0);
  }, 60_000);
});
