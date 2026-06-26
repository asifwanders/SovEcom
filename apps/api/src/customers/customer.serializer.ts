/**
 * Customer/address ALLOWLIST serializers (SECURITY-CRITICAL).
 *
 * Responses are built by EXPLICIT allowlist, never by spreading the row. This is
 * the hard guarantee that `password_hash`, `totp_secret`, and raw `metadata`
 * internals NEVER reach any response (admin or store). `vatValidated` is exposed
 * (it is a tax-relevant fact the client may show) but the metadata proof object
 * is not. Two views:
 *   - store (`/me`): the caller's own non-secret profile.
 *   - admin: the same plus admin-only facets (taxExempt, timestamps).
 */
import type { Customer } from '../database/schema/customers';
import type { CustomerAddress } from '../database/schema/customer_addresses';

export interface StoreCustomerView {
  id: string;
  email: string;
  name: string | null;
  phone: string | null;
  isB2b: boolean;
  vatNumber: string | null;
  vatValidated: boolean;
  acceptsMarketing: boolean;
  createdAt: string;
  /**
   * The proposed new address while an email change is in flight, or null. A non-secret
   * denormalized mirror of the unconsumed `email_change_tokens` row, exposed so the
   * storefront can show "a change to X is pending". NOT an oracle: it only ever reflects
   * the caller's OWN pending change.
   */
  pendingEmail: string | null;
}

export interface AdminCustomerView extends StoreCustomerView {
  taxExempt: boolean;
  vatValidatedAt: string | null;
  updatedAt: string;
}

export interface AddressView {
  id: string;
  type: 'shipping' | 'billing';
  isDefault: boolean;
  name: string;
  company: string | null;
  line1: string;
  line2: string | null;
  city: string;
  postalCode: string;
  region: string | null;
  country: string;
  phone: string | null;
}

/** Store self-service view — the caller's own data, no secrets. */
export function toStoreCustomerView(c: Customer): StoreCustomerView {
  return {
    id: c.id,
    email: c.email,
    name: c.name,
    phone: c.phone,
    isB2b: c.isB2b,
    vatNumber: c.vatNumber,
    vatValidated: c.vatValidated,
    acceptsMarketing: c.acceptsMarketing,
    createdAt: c.createdAt.toISOString(),
    pendingEmail: c.pendingEmail ?? null,
  };
}

/** Admin view — PII allowed under customers:read, but still NO secrets. */
export function toAdminCustomerView(c: Customer): AdminCustomerView {
  return {
    ...toStoreCustomerView(c),
    taxExempt: c.taxExempt,
    vatValidatedAt: c.vatValidatedAt ? c.vatValidatedAt.toISOString() : null,
    updatedAt: c.updatedAt.toISOString(),
  };
}

export function toAddressView(a: CustomerAddress): AddressView {
  return {
    id: a.id,
    type: a.type,
    isDefault: a.isDefault,
    name: a.name,
    company: a.company,
    line1: a.line1,
    line2: a.line2,
    city: a.city,
    postalCode: a.postalCode,
    region: a.region,
    country: a.country,
    phone: a.phone,
  };
}
