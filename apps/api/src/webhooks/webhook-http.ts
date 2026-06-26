/**
 * the outbound POST. Uses Node's built-in http(s) with the
 * `lookup` option pinned to {@link safeLookup} (re-resolves + re-validates the IP at connect →
 * DNS-rebinding-proof for hostnames) plus an explicit literal-IP guard (Node skips `lookup` for IP
 * literals — Fable BLOCKER-1). A HARD wall-clock deadline (not just the socket idle timeout — Fable
 * BLOCKER-3) and a capped, always-settling response drain (Fable BLOCKER-2) keep a hostile receiver
 * from wedging the serial worker. Returns the status code, or throws (recorded as a failed attempt).
 */
import * as http from 'node:http';
import * as https from 'node:https';
import { safeLookup, isLiteralAddressBlocked } from './ssrf';

export interface WebhookPostResult {
  statusCode: number;
}

const MAX_RESPONSE_BYTES = 64 * 1024;

export async function postWebhook(
  rawUrl: string,
  body: string,
  headers: Record<string, string>,
  timeoutMs = 10_000,
): Promise<WebhookPostResult> {
  const url = new URL(rawUrl);
  // Literal IP hosts never hit `safeLookup` — check them here so a literal loopback/private/mapped
  // target is refused at delivery, not only at create.
  if (isLiteralAddressBlocked(url.hostname)) {
    throw new Error('SSRF: blocked address');
  }
  const mod = url.protocol === 'https:' ? https : http;

  return new Promise<WebhookPostResult>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      fn();
    };
    // Hard overall deadline — independent of the socket idle timeout (a slow-loris drip resets that).
    const deadline = setTimeout(() => {
      req.destroy(new Error('request deadline exceeded'));
    }, timeoutMs);

    const req = mod.request(
      url,
      {
        method: 'POST',
        headers: {
          ...headers,
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(body)),
          'user-agent': 'SovEcom-Webhooks/1',
        },
        lookup: safeLookup,
        timeout: timeoutMs,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        let drained = 0;
        res.on('data', (chunk: Buffer) => {
          drained += chunk.length;
          if (drained > MAX_RESPONSE_BYTES) {
            res.destroy();
            // Over-cap is still a completed HTTP response — settle with the status (don't hang).
            finish(() => resolve({ statusCode: status }));
          }
        });
        res.on('end', () => finish(() => resolve({ statusCode: status })));
        res.on('close', () => finish(() => resolve({ statusCode: status })));
        res.on('error', (err) => finish(() => reject(err)));
      },
    );
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', (err) => finish(() => reject(err)));
    req.write(body);
    req.end();
  });
}
