/**
 * typed mutation helpers for the customer address book.
 *
 * Each helper calls a single endpoint via the browser-client generic and returns the server-shaped
 * result. Callers (AddressBook) own the 401-refresh retry loop and the refetch-after-success pattern.
 *
 * Endpoints (CustomerAuthGuard + IDOR-scoped — the server 404s if the address is not owned by the
 * authenticated customer):
 *   POST   /store/v1/customers/me/addresses         → created SavedAddress
 *   PATCH  /store/v1/customers/me/addresses/{id}    → updated SavedAddress
 *   DELETE /store/v1/customers/me/addresses/{id}    → void (204)
 *
 * Optional string fields: sent as `undefined` (omitted from JSON body) when empty, satisfying the
 * API's `.min(1)` constraints on nullable-optional fields.
 */
import type { SovEcomClient } from '@sovecom/client-js';
import type { SavedAddress } from './auth-context';

/** The fields needed to create a new address (mirrors the API CreateAddressDto). */
export interface CreateAddressInput {
  type: 'shipping' | 'billing';
  isDefault: boolean;
  name: string;
  company?: string;
  line1: string;
  line2?: string;
  city: string;
  postalCode: string;
  region?: string;
  country: string;
  phone?: string;
}

/** The fields that may be updated (mirrors the API UpdateAddressDto — all optional). */
export type UpdateAddressInput = Partial<CreateAddressInput>;

/**
 * Create a new saved address. Returns the server-assigned `SavedAddress` (with `id`, `isDefault`
 * reassigned if the server cleared the prior default of this type, etc.).
 */
export async function createAddress(
  client: SovEcomClient,
  body: CreateAddressInput,
): Promise<SavedAddress> {
  return client.request<'/store/v1/customers/me/addresses', 'post', SavedAddress>(
    'post',
    '/store/v1/customers/me/addresses',
    { body },
  );
}

/**
 * Update an existing address (partial). Returns the updated `SavedAddress`. The server 404s if the
 * address does not exist or is owned by another customer (IDOR guard).
 */
export async function updateAddress(
  client: SovEcomClient,
  id: string,
  body: UpdateAddressInput,
): Promise<SavedAddress> {
  return client.request<'/store/v1/customers/me/addresses/{id}', 'patch', SavedAddress>(
    'patch',
    '/store/v1/customers/me/addresses/{id}',
    { path: { id }, body },
  );
}

/**
 * Delete a saved address. Returns void (204). The server 404s if the address does not exist or is
 * owned by another customer (IDOR guard). Callers re-fetch the list after deletion.
 */
export async function deleteAddress(client: SovEcomClient, id: string): Promise<void> {
  return client.request<'/store/v1/customers/me/addresses/{id}', 'delete', void>(
    'delete',
    '/store/v1/customers/me/addresses/{id}',
    { path: { id } },
  );
}
