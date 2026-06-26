/**
 * Slot runtime — the SECURITY-CRITICAL untrusted-module render seam. EVOLVED
 * from the empty-registry stub: it now RENDERS module slot widgets, but only as DATA through
 * the closed MIT widget registry — NO module code/HTML ever reaches the DOM.
 *
 * `Slot` is an async RSC. Per render it:
 *   1. resolves the binding for `name` from the shared `cache()`-wrapped `GET /store/v1/slots` map
 * (`fetchSlots`). No binding or conflicted slot ⇒ render nothing.
 *   2. looks up the binding `component` in the closed `widgetRegistry`. Unknown type ⇒ render nothing.
 *   3. SPLITS on the registry `personalized` flag (the load-bearing caching invariant):
 *      - `personalized:false` (read-only) ⇒ SERVER-fetch the descriptor via `fetchSlotWidget`
 *        (route-keyed, no creds, cacheable, SEO-visible) → if non-null AND its `type` matches the
 *        binding component, render the MIT component with the validated props; null/mismatch ⇒ nothing.
 *      - `personalized:true` (interactive) ⇒ render the `SlotIsland` CLIENT island, passing the
 *        BINDING-derived `{ module, slot, route }`. The island fetches its OWN per-customer data
 *        client-side (`no-store`, credentialed) — so per-customer state is NEVER server-fetched/cached.
 *
 * Fail closed everywhere: unknown / invalid / oversized / slow / failing / non-200 ⇒ render nothing,
 * never throw, never 500 the page. A module must never break the page.
 *
 * `resolveSlot` / `EMPTY_REGISTRY` / the `SlotMap`/`SlotBinding` types are retained for the contract
 * typing and any legacy consumer; the live render path uses the widget registry, not a component map.
 */
import type { ReactNode } from 'react';
import type { SlotMap, SlotBinding } from '@sovecom/theme-sdk';
import { fetchSlots } from '@/lib/widgets/fetchSlots';
import { fetchSlotWidget } from '@/lib/widgets/fetchSlotWidget';
import { getWidget, renderReadOnlyWidget } from '@/lib/widgets/registry';
import { SlotIsland } from '@/lib/widgets/SlotIsland';

export type { SlotMap, SlotBinding };

/** A storefront slot component receives its resolved binding (legacy contract typing). */
export type SlotComponent = (props: { binding: SlotBinding }) => ReactNode;

/** Legacy registry type (retained for contract typing — the live path uses the widget registry). */
export type SlotRegistry = Readonly<Record<string, SlotComponent>>;

/** The legacy empty registry (retained for typing; the v1 widget render path no longer uses it). */
export const EMPTY_REGISTRY: SlotRegistry = Object.freeze({});

/** Stable lookup key for a binding (legacy helper). */
export function registryKey(binding: SlotBinding): string {
  return `${binding.module}:${binding.component}`;
}

/** Legacy resolver retained for contract typing; never throws. */
export function resolveSlot(
  slots: SlotMap,
  slot: string,
  registry: SlotRegistry = EMPTY_REGISTRY,
): SlotComponent | null {
  const binding = slots[slot];
  if (!binding) return null;
  return registry[registryKey(binding)] ?? null;
}

export interface SlotProps {
  /** The slot name to render (e.g. `"product-card-actions"`). */
  name: string;
  /** The route context (e.g. the PDP path/slug) threaded to the module fetch + the island. */
  route: string;
}

/**
 * Render whatever module widget is bound to `name`, fully defensively. See the file header for the
 * resolution + read/personalized split. Returns `null` (renders nothing) on every fail-closed path.
 */
export async function Slot({ name, route }: SlotProps): Promise<ReactNode> {
  const slots = await fetchSlots();
  if (!slots) return null;
  const binding: SlotBinding | undefined = slots[name];
  if (!binding) return null;

  const entry = getWidget(binding.component);
  if (!entry) return null;

  // Personalized (interactive) ⇒ client island; per-customer data is fetched client-side, never here.
  if (entry.personalized) {
    return (
      <SlotIsland module={binding.module} component={binding.component} slot={name} route={route} />
    );
  }

  // Read-only ⇒ server-fetch the descriptor (cacheable, no creds), then render the MIT component. Pin
  // the descriptor `type` to the BINDING component — a mismatch is refused (fail closed).
  const descriptor = await fetchSlotWidget(binding.module, name, route);
  if (!descriptor || descriptor.type !== binding.component) return null;

  // Render the registered MIT component via the TYPE-SAFE dispatcher (no `as never` — the switch hands
  // the component its exact typed props; React escapes them). `entry.personalized` is already false here.
  return renderReadOnlyWidget(descriptor);
}
