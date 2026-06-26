/**
 * notify-back-in-stock — the slot DATA handler. The module returns a typed widget descriptor
 * `{ type, props }` — data only, never code or HTML — over its store mount:
 * `GET /slot?slot=product-detail-actions&route=<variantId>`. The storefront validates it with
 * `parseWidget` and renders its own `submit-form` widget (a guest email-capture form).
 *
 * GUEST-FRIENDLY: the module is email-keyed (a guest supplies their own email), so the descriptor is
 * IDENTICAL whether or not a customer is signed in — it carries NO per-customer state. The form has a
 * single `email` field; the `submit-form` widget POSTs only its declared field values, so the variant
 * id rides in the action PATH (`/subscriptions/<variantId>`) — the path-based subscribe alias (see
 * api/handlers.ts). The action targets THIS module's OWN subscribe mount.
 *
 * Fail-closed: an unknown slot or a missing/invalid route ⇒ 204 (decline).
 */
import type { ModuleHttpRequest, ModuleHttpResponse } from '@sovecom/module-sdk';

/** The slot this module fills (must match `sovecom.module.json` slots[].slot). */
export const NOTIFY_SLOT = 'product-detail-actions';

/** This module's own store mount — the only origin its action path may target. */
const OWN_MOUNT = '/store/v1/modules/notify-back-in-stock';

/** First value for a query key (the query may carry repeated keys → string[]). */
function firstQuery(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Forbidden bytes in the route variant id: control chars (C0 + DEL) or a path separator (`/`, `\`). The
 * route id becomes a path SEGMENT in the emitted action path, so reject anything that could smuggle a
 * separator/control byte (defense-in-depth; C1's actionPathSchema would also reject the resulting path).
 */
// eslint-disable-next-line no-control-regex
const FORBIDDEN_ROUTE_CHARS = /[\x00-\x1f\x7f/\\]/;

/** A bound variant-id route value (trimmed, 1–64 chars, no control/separator chars). */
function readRouteVariantId(req: ModuleHttpRequest): string | undefined {
  const value = firstQuery(req.query.route);
  if (typeof value !== 'string') return undefined;
  const v = value.trim();
  if (v.length === 0 || v.length > 64) return undefined;
  if (FORBIDDEN_ROUTE_CHARS.test(v)) return undefined;
  return v;
}

/** A bodyless 204 — the module declines to render at this slot. */
function decline(): ModuleHttpResponse {
  return { status: 204 };
}

/**
 * Handle `GET /slot`. Returns a `submit-form` descriptor (guest email capture) for the route's variant,
 * or 204 (unknown slot / invalid route). NO customer scoping — the form is guest-friendly.
 */
export function handleNotifySlot(req: ModuleHttpRequest): ModuleHttpResponse {
  if (firstQuery(req.query.slot) !== NOTIFY_SLOT) return decline();

  const variantId = readRouteVariantId(req);
  if (!variantId) return decline();

  // The variant id rides in the PATH (the form posts only its declared fields). encodeURIComponent keeps
  // it a single inert segment under the own mount. This is DEFENSE-IN-DEPTH and intentionally redundant:
  // `readRouteVariantId` already rejects an id with `/`, `\`, or a control char, and C1's actionPathSchema
  // bans `%` outright (a clean id never needs encoding) — but encoding here means even if those layers
  // ever changed, a reserved char could not break out of the single path segment. C2 then pins the module.
  const seg = encodeURIComponent(variantId);
  const descriptor = {
    type: 'submit-form' as const,
    props: {
      action: { path: `${OWN_MOUNT}/subscriptions/${seg}` },
      submitLabel: 'Notify me',
      fields: [
        {
          name: 'email',
          label: 'Email me when this is back in stock',
          kind: 'email' as const,
          required: true,
        },
      ],
      successMessage: "We'll email you when it's back in stock.",
    },
  };
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(descriptor),
  };
}
