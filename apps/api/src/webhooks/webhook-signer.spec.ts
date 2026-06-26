/**
 * signer unit tests: a receiver recomputing HMAC-SHA256 over
 * `timestamp.nonce.body` with the same secret gets the same signature; a different secret/body
 * does not; headers are well-formed.
 */
import { createHmac } from 'node:crypto';
import {
  buildSignatureHeaders,
  computeSignature,
  signingString,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  NONCE_HEADER,
} from './webhook-signer';

import * as signerModule from './webhook-signer';

describe('Z8 dead-code: REPLAY_WINDOW_SECONDS must NOT be exported', () => {
  it('webhook-signer does not export REPLAY_WINDOW_SECONDS', () => {
    expect((signerModule as Record<string, unknown>)['REPLAY_WINDOW_SECONDS']).toBeUndefined();
  });
});

describe('webhook signer', () => {
  const secret = 'whsec_test_secret';
  const body = JSON.stringify({ event: 'order.created', data: { orderId: 'o1' } });

  it('computeSignature matches an independent HMAC-SHA256 over timestamp.nonce.body', () => {
    const ts = '1700000000';
    const nonce = 'abc123';
    const expected = createHmac('sha256', secret).update(`${ts}.${nonce}.${body}`).digest('hex');
    expect(computeSignature(secret, ts, nonce, body)).toBe(expected);
    expect(signingString(ts, nonce, body)).toBe(`${ts}.${nonce}.${body}`);
  });

  it('a receiver can verify the built headers', () => {
    const h = buildSignatureHeaders(secret, body, 1700000000);
    expect(h[TIMESTAMP_HEADER]).toBe('1700000000');
    expect(h[NONCE_HEADER]).toMatch(/^[0-9a-f]{32}$/);
    expect(h[SIGNATURE_HEADER]).toMatch(/^sha256=[0-9a-f]{64}$/);

    const sig = h[SIGNATURE_HEADER]!.slice('sha256='.length);
    const recomputed = computeSignature(secret, h[TIMESTAMP_HEADER]!, h[NONCE_HEADER]!, body);
    expect(recomputed).toBe(sig);
  });

  it('a wrong secret or tampered body fails verification', () => {
    const h = buildSignatureHeaders(secret, body, 1700000000);
    const sig = h[SIGNATURE_HEADER]!.slice('sha256='.length);
    expect(computeSignature('wrong', h[TIMESTAMP_HEADER]!, h[NONCE_HEADER]!, body)).not.toBe(sig);
    expect(computeSignature(secret, h[TIMESTAMP_HEADER]!, h[NONCE_HEADER]!, body + 'x')).not.toBe(
      sig,
    );
  });

  it('nonce is unique per call', () => {
    const a = buildSignatureHeaders(secret, body, 1700000000);
    const b = buildSignatureHeaders(secret, body, 1700000000);
    expect(a[NONCE_HEADER]).not.toBe(b[NONCE_HEADER]);
  });
});
