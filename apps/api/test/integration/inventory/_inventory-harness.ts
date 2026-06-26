/**
 * Inventory reservation integration harness.
 *
 * Reuses the cart harness boot (full AppModule against real Postgres + Redis),
 * adding helpers to: seed a single variant with an arbitrary stock level, seed
 * a Postgres cart row so reservations can FK to it, manipulate reservation rows
 * directly (TTL simulation), and seed/login an admin for the debug endpoint.
 */
import 'reflect-metadata';
import request from 'supertest';
import * as argon2 from 'argon2';
import { uuidv7 } from 'uuidv7';
import { randomUUID } from 'node:crypto';
import {
  bootCartApp,
  resetCartState,
  DEFAULT_TENANT_ID,
  type CartHarness,
} from '../cart/_cart-harness';

export { DEFAULT_TENANT_ID } from '../cart/_cart-harness';
export type InventoryHarness = CartHarness;

export const newId = (): string => uuidv7();

export async function bootInventoryApp(): Promise<InventoryHarness> {
  return bootCartApp();
}

export async function resetInventoryState(h: InventoryHarness): Promise<void> {
  // resetCartState truncates carts (CASCADE covers inventory_reservations), but
  // we add the reservation table explicitly for clarity / belt-and-braces. It
  // also re-seeds the default tenant + system_state.
  await resetCartState(h);
  await h.client.unsafe(`TRUNCATE TABLE inventory_reservations, users RESTART IDENTITY CASCADE`);
}

/** Seed a published product + ONE variant with the given stock / backorder flag. */
export async function seedVariant(
  h: InventoryHarness,
  opts: { stock?: number; allowBackorder?: boolean; tenantId?: string; currency?: string } = {},
): Promise<{ productId: string; variantId: string }> {
  const tenantId = opts.tenantId ?? DEFAULT_TENANT_ID;
  const stock = opts.stock ?? 10;
  const allowBackorder = opts.allowBackorder ?? false;
  const currency = opts.currency ?? 'EUR';
  const productId = newId();
  const variantId = newId();

  // Use the FULL ids in slug/sku: uuidv7's first 8 hex chars are a ms timestamp,
  // so two seeds in the same millisecond would collide on a truncated slug.
  await h.client`
    insert into products (id, tenant_id, title, slug, status)
    values (${productId}, ${tenantId}, ${'Inv Product'}, ${`inv-${productId}`}, ${'published'})
  `;
  await h.client`
    insert into product_variants
      (id, tenant_id, product_id, sku, title, options, price_amount, currency, stock_quantity, allow_backorder)
    values
      (${variantId}, ${tenantId}, ${productId}, ${`INV-${variantId}`}, ${'V'}, ${'{}'}::jsonb,
       ${1000}, ${currency}, ${stock}, ${allowBackorder})
  `;
  return { productId, variantId };
}

/** Insert an empty cart row in Postgres so reservations can FK to it. */
export async function seedCart(
  h: InventoryHarness,
  opts: { tenantId?: string; currency?: string } = {},
): Promise<string> {
  const tenantId = opts.tenantId ?? DEFAULT_TENANT_ID;
  const currency = opts.currency ?? 'EUR';
  const cartId = newId();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  await h.client`
    insert into carts (id, tenant_id, session_token, currency, status, expires_at)
    values (${cartId}, ${tenantId}, ${randomUUID()}, ${currency}, ${'active'}, ${expiresAt})
  `;
  return cartId;
}

export interface ReservationRow {
  id: string;
  tenant_id: string;
  variant_id: string;
  cart_id: string;
  quantity: number;
  status: string;
  expires_at: Date;
}

/** All reservation rows for a variant (most-recent first). */
export async function reservationsForVariant(
  h: InventoryHarness,
  variantId: string,
): Promise<ReservationRow[]> {
  return h.client<ReservationRow[]>`
    select * from inventory_reservations where variant_id = ${variantId}
    order by created_at desc
  `;
}

/** All reservation rows for a cart. */
export async function reservationsForCart(
  h: InventoryHarness,
  cartId: string,
): Promise<ReservationRow[]> {
  return h.client<ReservationRow[]>`
    select * from inventory_reservations where cart_id = ${cartId} order by created_at desc
  `;
}

/** Force a reservation's expires_at into the past (TTL-expiry simulation). */
export async function expireReservation(
  h: InventoryHarness,
  cartId: string,
  variantId: string,
): Promise<void> {
  await h.client`
    update inventory_reservations
    set expires_at = now() - interval '1 minute'
    where cart_id = ${cartId} and variant_id = ${variantId}
  `;
}

/** Read current stock_quantity for a variant. */
export async function stockOf(h: InventoryHarness, variantId: string): Promise<number> {
  const rows = await h.client<{ stock_quantity: number }[]>`
    select stock_quantity from product_variants where id = ${variantId}
  `;
  return Number(rows[0]!.stock_quantity);
}

/** Seed an admin user (real argon2 hash) + login → bearer token. */
export async function seedAndLoginAdmin(
  h: InventoryHarness,
  opts: { role?: 'owner' | 'admin' | 'staff'; tenantId?: string } = {},
): Promise<{ id: string; email: string; bearer: string }> {
  const tenantId = opts.tenantId ?? DEFAULT_TENANT_ID;
  const role = opts.role ?? 'admin';
  const id = newId();
  const email = `inv-admin-${id.slice(0, 8)}@x.test`;
  const password = 'correct horse battery staple';
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });

  await h.client`
    insert into users (id, tenant_id, email, password_hash, name, role, totp_enabled)
    values (${id}, ${tenantId}, ${email}, ${passwordHash}, ${'Inv Admin'}, ${role}, ${false})
  `;

  const login = await request(h.http()).post('/admin/v1/auth/login').send({ email, password });
  if (login.status !== 200) {
    throw new Error(`admin login failed: ${login.status} ${JSON.stringify(login.body)}`);
  }
  return { id, email, bearer: `Bearer ${login.body.accessToken as string}` };
}
