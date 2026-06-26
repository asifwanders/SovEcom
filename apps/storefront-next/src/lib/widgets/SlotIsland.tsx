'use client';

/**
 * Personalized client island. Renders an interactive (`personalized:true`) widget WITHOUT any server
 * fetch — per-customer state is fetched CLIENT-side on mount so it NEVER lands in an ISR cache.
 *
 * The flow, all fail-closed (renders NOTHING on any failure, never throws):
 *   1. resolve the binding `component` against the closed registry — unknown ⇒ render nothing (no fetch);
 *   2. fetch the module's OWN mount (`/store/v1/modules/<binding.module>/slot?…`) — the URL is built
 *      from the BINDING module, never a descriptor host;
 *   3. bound the body VOLUME (Content-Length + a cap) so a malicious module can't OOM the tab;
 *   4. re-validate the response through C1 `parseWidget` (untrusted input);
 *   5. pin the descriptor `type` to the binding `component` (a module can't switch widget under us);
 *   6. render the registered interactive component via the TYPE-SAFE dispatcher, passing the BINDING
 *      module so the widget enforces own-mount on its action paths (a cross-module path ⇒ renders nothing).
 *
 * `data-slot-island` markers let the server-side `<Slot>` test assert the island is mounted (and that
 * the server did NOT fetch personalized data).
 */
import { useEffect, useState } from 'react';
import { parseWidget, type WidgetDescriptor } from '@sovecom/theme-sdk';
import { apiBaseUrl } from '@/lib/browser-client';
import { useAuth } from '@/lib/auth-context';
import { getWidget, renderPersonalizedWidget } from './registry';
import { WIDGET_FETCH_MAX_BYTES, readCappedBody } from './widgetBytes';
import { bearerAuthHeaders } from './authHeaders';

const TIMEOUT_MS = 8000;

export interface SlotIslandProps {
  /** The BINDING module (own-mount source of truth) — never the descriptor. */
  module: string;
  /** The BINDING component (the widget type the slot is bound to). */
  component: string;
  /** The slot name. */
  slot: string;
  /** The route context. */
  route: string;
}

export function SlotIsland({ module, component, slot, route }: SlotIslandProps) {
  const [descriptor, setDescriptor] = useState<WidgetDescriptor | null>(null);
  // The store-module proxy reads `req.customer` ONLY from a Bearer token (NOT the cookie), so attach
  // the in-memory access token as a Bearer on the GET — without it, a personalized module always sees
  // an anonymous request (the wishlist toggle would 204 forever for a logged-in shopper). `getAccessToken`
  // is the SAME live getter `createBrowserClient({ getAccessToken })` uses in account/checkout; it lives
  // only in auth-context memory. A guest (no token) sends NO Authorization header → module sees anonymous.
  const { getAccessToken } = useAuth();

  // Resolve the binding component up front — an unknown / non-personalized component renders nothing
  // (and never fetches). Only personalized widgets belong in a client island.
  const entry = getWidget(component);
  const renderable = entry?.personalized === true;

  useEffect(() => {
    if (!renderable) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let active = true;
    (async () => {
      try {
        const url =
          `${apiBaseUrl()}/store/v1/modules/${encodeURIComponent(module)}/slot` +
          `?slot=${encodeURIComponent(slot)}&route=${encodeURIComponent(route)}`;
        const res = await fetch(url, {
          method: 'GET',
          cache: 'no-store',
          credentials: 'include',
          // Bearer when logged in; nothing for a guest (guest → module sees anonymous).
          headers: bearerAuthHeaders(getAccessToken),
          signal: controller.signal,
        });
        if (res.status !== 200) {
          // S3: release the unconsumed body on the failure path.
          await res.body?.cancel().catch(() => {});
          return;
        }
        // VOLUME guard: reject an over-cap Content-Length up front, else stream-read with a running cap.
        const declared = Number(res.headers.get('content-length'));
        if (Number.isFinite(declared) && declared > WIDGET_FETCH_MAX_BYTES) {
          await res.body?.cancel().catch(() => {});
          return;
        }
        const text = await readCappedBody(res, controller);
        if (text === null) return;
        const parsed = parseWidget(text);
        // Pin the descriptor type to the BINDING component — a mismatch is refused.
        if (parsed && parsed.type === component && active) setDescriptor(parsed);
      } catch {
        // Fail closed — render nothing.
      } finally {
        clearTimeout(timer);
      }
    })();
    return () => {
      active = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, [renderable, module, component, slot, route, getAccessToken]);

  if (!renderable) return null;

  // Render the registered interactive widget via the TYPE-SAFE dispatcher (no `as never`): it switches on
  // the descriptor's narrowed type and hands the component its exact props + the BINDING module (the
  // widget then enforces own-mount on its action paths from that module name) + the `getAccessToken`
  // getter so the widget's own POST-back carries the same Bearer auth as the GET (the proxy reads the
  // customer only from Bearer). The widget sends no Authorization header for a guest.
  return (
    <span data-slot-island data-module={module} data-slot={slot} data-route={route}>
      {descriptor ? renderPersonalizedWidget(descriptor, module, getAccessToken) : null}
    </span>
  );
}
