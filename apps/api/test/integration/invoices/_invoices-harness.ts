/**
 * Invoices integration harness.
 *
 * Reuses the orders harness (real Postgres + Redis, full AppModule) and adds:
 *  - invoice/counter truncation in the per-test reset,
 *  - a helper to mark an order paid via the admin endpoint (drives `order.paid` → issuance),
 *  - a helper to set the tenant business identity + EU-VAT registration JSONB (seller snapshot),
 *  - a poll helper that waits for the async listener to issue the invoice.
 */
import request from 'supertest';
import { resetOrderState, DEFAULT_TENANT_ID, type CartHarness } from '../orders/_orders-harness';
import { TenantSettingsService } from '../../../src/taxes/tenant-settings.service';

export {
  bootCartApp,
  resetOrderState,
  seedSimpleProduct,
  driveCartToCheckoutReady,
  signupAndLoginCustomer,
  seedAdminAndLogin,
  setTaxSettings,
  extractCartTokenCookie,
  seedShippingRate,
  DEFAULT_TENANT_ID,
  newId,
  type CartHarness,
} from '../orders/_orders-harness';
export { seedTaxRate } from '../cart/_cart-harness';

/**
 * Per-test reset. `resetOrderState` already truncates invoices + invoice_counters (CASCADE
 * from orders) WITH a deadlock-retry that tolerates a still-in-flight async issuance tx — so
 * we delegate to it rather than running a second, un-retried TRUNCATE that could deadlock.
 */
export async function resetInvoiceState(h: CartHarness): Promise<void> {
  await resetOrderState(h);
}

/**
 * Set the tenant's business identity (+ optional EU-VAT registration) in `tenants.settings`,
 * preserving the tax_mode etc. already there. `name`/`address` go to `business_identity`;
 * `siren` too; `vatNumber`/`originCountry` to `eu_vat_registration` (where the service reads
 * the seller VAT number). Invalidates the TenantSettingsService cache.
 */
export async function setBusinessIdentity(
  h: CartHarness,
  opts: {
    name?: string;
    siren?: string | null;
    address?: Record<string, unknown> | null;
    vatNumber?: string | null;
    originCountry?: string | null;
    taxMode?: 'none' | 'eu_vat';
  },
): Promise<void> {
  const rows = await h.client<{ settings: Record<string, unknown> }[]>`
    select settings from tenants where id = ${DEFAULT_TENANT_ID}
  `;
  const settings: Record<string, unknown> = { ...(rows[0]?.settings ?? {}) };

  if (opts.taxMode !== undefined) settings.tax_mode = opts.taxMode;

  settings.business_identity = {
    name: opts.name ?? 'Acme SARL',
    siren: opts.siren ?? null,
    address:
      opts.address === undefined
        ? {
            name: opts.name ?? 'Acme SARL',
            line1: '10 rue du Commerce',
            city: 'Paris',
            postalCode: '75001',
            country: 'FR',
          }
        : opts.address,
  };

  if (opts.vatNumber !== undefined || opts.originCountry !== undefined) {
    const reg = (settings.eu_vat_registration as Record<string, unknown>) ?? {};
    settings.eu_vat_registration = {
      ...reg,
      vat_number: opts.vatNumber ?? reg.vat_number ?? null,
      origin_country: opts.originCountry ?? reg.origin_country ?? null,
    };
  }

  await h.client`
    update tenants set settings = ${JSON.stringify(settings)}::jsonb, updated_at = now()
    where id = ${DEFAULT_TENANT_ID}
  `;
  // Drop the in-process tax-settings cache so the seller identity read sees the new JSONB.
  h.app.get(TenantSettingsService, { strict: false }).invalidate(DEFAULT_TENANT_ID);
}

/** Mark an order paid via the admin endpoint (drives `order.paid`). */
export async function markOrderPaid(
  h: CartHarness,
  orderId: string,
  adminToken: string,
): Promise<request.Response> {
  return request(h.http())
    .post(`/admin/v1/orders/${orderId}/mark-paid`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({});
}

/** Poll the invoices table until the async listener has issued one for the order (or timeout). */
export async function waitForInvoice(
  h: CartHarness,
  orderId: string,
  timeoutMs = 5000,
): Promise<{ id: string; series: string; invoice_number: string; storage_key: string | null }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await h.client<
      { id: string; series: string; invoice_number: string; storage_key: string | null }[]
    >`
      select id, series, invoice_number, storage_key from invoices
      where order_id = ${orderId} and type = 'invoice'
    `;
    if (rows.length > 0) return rows[0]!;
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for invoice for order ${orderId}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Poll until the invoice's storage_key is non-null (the post-commit PDF render landed). */
export async function waitForStoredInvoice(
  h: CartHarness,
  orderId: string,
  timeoutMs = 5000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await h.client<{ storage_key: string | null }[]>`
      select storage_key from invoices where order_id = ${orderId} and type = 'invoice'
    `;
    if (rows[0]?.storage_key) return rows[0].storage_key;
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for stored invoice PDF for order ${orderId}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}
