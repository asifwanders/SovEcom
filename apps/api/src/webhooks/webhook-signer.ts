/**
 * Outbound webhook signing.
 *
 * HMAC-SHA256 with the subscription secret over the EXACT string `${timestamp}.${nonce}.${body}`,
 * binding the timestamp+nonce so a captured request can't be replayed with a fresh timestamp. The
 * `body` passed here MUST be the exact bytes sent on the wire. Receivers recompute the HMAC and
 * reject a `timestamp` older than 5 minutes (documented for integrators).
 */
import { createHmac, randomBytes } from 'node:crypto';

export const SIGNATURE_HEADER = 'X-SovEcom-Signature';
export const TIMESTAMP_HEADER = 'X-SovEcom-Timestamp';
export const NONCE_HEADER = 'X-SovEcom-Nonce';

export type SignedHeaders = Record<string, string>;

/** The canonical signed string. Exposed so tests/receivers compute the identical input. */
export function signingString(timestamp: string, nonce: string, body: string): string {
  return `${timestamp}.${nonce}.${body}`;
}

/** Hex HMAC-SHA256 of `${timestamp}.${nonce}.${body}` under `secret`. */
export function computeSignature(
  secret: string,
  timestamp: string,
  nonce: string,
  body: string,
): string {
  return createHmac('sha256', secret)
    .update(signingString(timestamp, nonce, body))
    .digest('hex');
}

/**
 * Build the signature headers for a delivery. `nowSeconds` is injectable for tests; defaults to the
 * current unix time. `nonce` is random per call.
 */
export function buildSignatureHeaders(
  secret: string,
  body: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): SignedHeaders {
  const timestamp = String(nowSeconds);
  const nonce = randomBytes(16).toString('hex');
  return {
    [SIGNATURE_HEADER]: `sha256=${computeSignature(secret, timestamp, nonce, body)}`,
    [TIMESTAMP_HEADER]: timestamp,
    [NONCE_HEADER]: nonce,
  };
}
