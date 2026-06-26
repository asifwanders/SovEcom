/**
 * C2 shared, ISOMORPHIC body-volume bound (S1 / N2). Used by BOTH the server `fetchSlotWidget` and the
 * client `SlotIsland` to bound how much of an untrusted module response is ever materialized — so a
 * malicious module can't OOM the Node process (server) or the tab (client) by streaming gigabytes within
 * the duration timeout. No `next/headers`, no server-only imports — safe to pull into the client bundle.
 */

/** Byte cap on a raw slot-widget response body (reuses C1's descriptor cap value — one bound). */
export const WIDGET_FETCH_MAX_BYTES = 64 * 1024;

/**
 * Read a `Response` body as a stream, accumulating UTF-8 text up to {@link WIDGET_FETCH_MAX_BYTES}.
 * Returns the decoded text, or `null` the MOMENT the running byte count exceeds the cap — aborting the
 * passed controller and cancelling the reader so the connection is torn down and an over-cap body is
 * NEVER fully buffered (volume bound, not just the duration timeout). A stream error propagates to the
 * caller's try/catch (⇒ null). Falls back to a capped `text()` only when there is no `ReadableStream`.
 */
export async function readCappedBody(
  res: Response,
  controller: AbortController,
): Promise<string | null> {
  const body = res.body;
  if (!body) {
    const text = await res.text();
    return new TextEncoder().encode(text).length > WIDGET_FETCH_MAX_BYTES ? null : text;
  }
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let running = 0;
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    running += value.byteLength;
    if (running > WIDGET_FETCH_MAX_BYTES) {
      controller.abort();
      await reader.cancel().catch(() => {});
      return null;
    }
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}
