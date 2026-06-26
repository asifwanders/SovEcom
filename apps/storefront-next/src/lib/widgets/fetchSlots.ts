/**
 * slot-map fetch — the `cache`-wrapped `GET /store/v1/slots` read. Shared across every `<Slot>` on
 * the page via React `cache()` (ONE round-trip per render pass), NULL on any transport error.
 * The API returns ONLY cleanly-resolved slots; a conflicted or unresolved slot is OMITTED.
 * `createStoreClient()` sends no credentials by design, so this PUBLIC read is cacheable and safe to share.
 */
import { cache } from 'react';
import type { SlotMap, SlotBinding } from '@sovecom/theme-sdk';
import { createStoreClient } from '@/lib/store-client';

/** True iff `v` is a well-formed `{ module: string, component: string }` binding (N3). */
function isBinding(v: unknown): v is SlotBinding {
  if (!v || typeof v !== 'object') return false;
  const b = v as Record<string, unknown>;
  return typeof b.module === 'string' && typeof b.component === 'string';
}

/**
 * Fetch the resolved slot map server-side. Returns a `SlotMap` (possibly empty) keeping ONLY
 * well-formed `{module, component}` bindings, or `null` on any transport error. The slots endpoint is
 * PUBLIC, so no cookie/auth is forwarded (cacheable, shared). Never throws.
 */
export const fetchSlots = cache(async (): Promise<SlotMap | null> => {
  try {
    const client = createStoreClient();
    const raw = await client.request<'/store/v1/slots', 'get', unknown>('get', '/store/v1/slots');
    // Defensive: the wire shape is a plain object; a null/garbage body falls back to no module UI.
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    // N3: keep only well-formed bindings; ignore any malformed entry rather than relying on a downstream
    // `getWidget(undefined)`. Own-key only (skips prototype keys).
    const out: SlotMap = {};
    for (const [slot, binding] of Object.entries(raw as Record<string, unknown>)) {
      if (isBinding(binding)) out[slot] = binding;
    }
    return out;
  } catch {
    return null;
  }
});
