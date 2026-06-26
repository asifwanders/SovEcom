/**
 * the stable RPC error codes carried on a broker response,
 * EXTRACTED here so module authors can branch on failures (e.g. distinguish `forbidden` from
 * `timeout`) without string-matching. Was defined in
 * `apps/api/src/modules/runtime/ipc-protocol.ts`; apps/api now imports it from here.
 *
 * This is the ONLY runtime-value half of the error contract the SDK exposes. The IPC envelope,
 * frame Zod schemas, and `RpcError` class stay core-side (transport/enforcement, not contract).
 */

/** Stable error codes carried on a response frame. */
export const RpcErrorCode = {
  /** The peer did not register a handler for the requested method. */
  UNKNOWN_METHOD: 'unknown_method',
  /** The request timed out waiting for a response. */
  TIMEOUT: 'timeout',
  /** The handler threw. */
  HANDLER_ERROR: 'handler_error',
  /** The channel closed before a response arrived. */
  CHANNEL_CLOSED: 'channel_closed',
  /** Params/result failed validation, or a frame was malformed. */
  PROTOCOL: 'protocol',
  /** The broker refused the call (permission / tenant / transactional-path). */
  FORBIDDEN: 'forbidden',
  /** The capability exists in the manifest vocabulary but is not implemented yet. */
  NOT_AVAILABLE: 'not_available',
  /**
   * The worker's inbound RPC concurrency cap was exceeded (DoS hardening).
   * The caller should back off and retry rather than queuing indefinitely in core.
   */
  BUSY: 'busy',
  /**
   * A per-module capability rate limit was exceeded (e.g. `email:send`). The call was
   * REFUSED, not queued; the caller should back off until the limit window rolls over. Distinct
   * from {@link BUSY} (transient concurrency) — this is a sustained-volume cap on a side-effecting
   * capability, surfaced to the module as a clean refusal rather than a thrown crash.
   */
  RATE_LIMITED: 'rate_limited',
} as const;

export type RpcErrorCode = (typeof RpcErrorCode)[keyof typeof RpcErrorCode];
