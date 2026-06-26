/**
 * Server-side widget fetch. `cache()`-wrapped, timeout-bounded, NULL on ANY failure.
 *
 * Fetches `GET /store/v1/modules/<module>/slot?slot=&route=`. This is the READ-ONLY server path for
 * `personalized:false` widgets: ROUTE-KEYED and carries NO customer credentials so its result is
 * SEO-visible and cacheable. It MUST NEVER be called for a personalized widget. VOLUME is bounded, not
 * just duration: the body is read as a STREAM with a running cap so over-cap bodies are never buffered.
 * Any failure (non-200, transport error, timeout, oversized, invalid) returns `null`. Never throws.
 */
import { cache } from 'react';
import { parseWidget, type WidgetDescriptor } from '@sovecom/theme-sdk';
import { getApiBaseUrl } from '@/lib/store-client';
import { WIDGET_FETCH_MAX_BYTES, readCappedBody } from './widgetBytes';

/** Re-exported for callers/tests; the canonical home is the isomorphic `widgetBytes` module. */
export { WIDGET_FETCH_MAX_BYTES };

/** Default server-fetch timeout (ms). Mirrors the other bounded storefront reads — fail-fast to null. */
const DEFAULT_TIMEOUT_MS = 2000;

/**
 * Fetch + validate a read-only slot widget for `(module, slot, route)`. Returns the typed descriptor,
 * or `null` on any failure. Never throws. `cache()`-wrapped so multiple `<Slot>`s for the same
 * `(module, slot, route)` share ONE round-trip per render pass.
 */
export const fetchSlotWidget = cache(
  async (
    module: string,
    slot: string,
    route: string,
    opts?: { timeoutMs?: number },
  ): Promise<WidgetDescriptor | null> => {
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const base = getApiBaseUrl();
      const url =
        `${base}/store/v1/modules/${encodeURIComponent(module)}/slot` +
        `?slot=${encodeURIComponent(slot)}&route=${encodeURIComponent(route)}`;

      // NO credentials, NO cookie, NO Authorization — this is the cacheable, route-keyed server read.
      const res = await fetch(url, { method: 'GET', signal: controller.signal });
      if (res.status !== 200) {
        // S3: release the unconsumed body on the failure path (no per-slot resource leak).
        await res.body?.cancel().catch(() => {});
        return null;
      }

      // VOLUME guard (S1): reject an over-cap Content-Length up front (no read), else stream-read with a
      // running cap so an over-cap body is never materialized (an OOM would 500 the page for everyone).
      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > WIDGET_FETCH_MAX_BYTES) {
        await res.body?.cancel().catch(() => {});
        return null;
      }

      const text = await readCappedBody(res, controller);
      if (text === null) return null;

      // Re-validate as UNTRUSTED input through C1. On ANY failure parseWidget returns null → render nothing.
      return parseWidget(text);
    } catch {
      // Transport error / timeout (AbortError) / anything else ⇒ fail closed.
      return null;
    } finally {
      clearTimeout(timer);
    }
  },
);
