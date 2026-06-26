/**
 * Broker-mediated outbound HTTP.
 *
 * The ONLY sanctioned egress for a module. A module has no `fetch`/`net` of its own that core
 * trusts (denied at the deployment boundary); when it wants to call out it asks the broker, and
 * THIS is the chokepoint. Enforcement, in order:
 *   1. **https-only** (an http escape exists for dev/test against a local server);
 *   2. **host allowlist** — default-deny; the host must be in the module's admin-approved set;
 *   3. **SSRF guard** — literal private/loopback/link-local/metadata IPs refused, and DNS is
 *      re-resolved AT CONNECT with {@link safeLookup} so a rebind can't sneak past;
 *   4. **bounds** — method allowlist, request/response size caps, a hard timeout.
 * Every violation throws an {@link RpcError} FORBIDDEN, surfaced to the module as a denied call.
 */
import * as http from 'node:http';
import * as https from 'node:https';
import { URL } from 'node:url';

import { isLiteralAddressBlocked, safeLookup } from '../../webhooks/ssrf';
import { RpcError, RpcErrorCode } from './ipc-protocol';

export interface HttpEgressRequest {
  readonly url: string;
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
}

export interface HttpEgressResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}

export interface HttpEgressPort {
  fetch(req: HttpEgressRequest, allowlist: ReadonlySet<string>): Promise<HttpEgressResponse>;
}

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);
const MAX_REQUEST_BODY_BYTES = 256 * 1024; // 256 KiB
const MAX_RESPONSE_BYTES = 1 * 1024 * 1024; // 1 MiB
const TIMEOUT_MS = 10_000;
/** Hop-by-hop / spoofable headers a module may never set on an outbound request. */
const FORBIDDEN_REQUEST_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
  'cookie',
  'authorization',
]);

const devOrTest = (): boolean =>
  process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development';
const allowInsecure = (): boolean =>
  devOrTest() && process.env.MODULE_EGRESS_ALLOW_INSECURE === 'true';

/**
 * Validate the target BEFORE any network: https-only, host in the allowlist, not a blocked
 * literal IP. Returns the parsed URL. Throws {@link RpcError} FORBIDDEN on any violation.
 */
export function assertEgressAllowed(rawUrl: string, allowlist: ReadonlySet<string>): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new RpcError(RpcErrorCode.FORBIDDEN, 'egress: invalid URL');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && allowInsecure())) {
    throw new RpcError(RpcErrorCode.FORBIDDEN, 'egress: only https is allowed');
  }
  const host = url.hostname.toLowerCase();
  if (!allowlist.has(host)) {
    throw new RpcError(RpcErrorCode.FORBIDDEN, `egress: host not allowlisted: ${host}`);
  }
  // Literal-IP guard (safeLookup covers DNS names at connect; it is NOT called for literals).
  if (isLiteralAddressBlocked(url.hostname)) {
    throw new RpcError(RpcErrorCode.FORBIDDEN, 'egress: target resolves to a blocked address');
  }
  return url;
}

export class NodeHttpEgress implements HttpEgressPort {
  fetch(req: HttpEgressRequest, allowlist: ReadonlySet<string>): Promise<HttpEgressResponse> {
    const url = assertEgressAllowed(req.url, allowlist);
    const method = (req.method ?? 'GET').toUpperCase();
    if (!ALLOWED_METHODS.has(method)) {
      return Promise.reject(
        new RpcError(RpcErrorCode.FORBIDDEN, `egress: method not allowed: ${method}`),
      );
    }
    const bodyBuf = req.body ? Buffer.from(req.body, 'utf8') : undefined;
    if (bodyBuf && bodyBuf.byteLength > MAX_REQUEST_BODY_BYTES) {
      return Promise.reject(new RpcError(RpcErrorCode.FORBIDDEN, 'egress: request body too large'));
    }
    const headers = sanitizeHeaders(req.headers);
    if (bodyBuf) headers['content-length'] = String(bodyBuf.byteLength);

    const mod = url.protocol === 'https:' ? https : http;
    return new Promise<HttpEgressResponse>((resolve, reject) => {
      const request = mod.request(
        url,
        { method, headers, lookup: safeLookup, timeout: TIMEOUT_MS },
        (res) => {
          const chunks: Buffer[] = [];
          let total = 0;
          res.on('data', (chunk: Buffer) => {
            total += chunk.length;
            if (total > MAX_RESPONSE_BYTES) {
              request.destroy(new RpcError(RpcErrorCode.FORBIDDEN, 'egress: response too large'));
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => {
            resolve({
              status: res.statusCode ?? 0,
              headers: flattenHeaders(res.headers),
              body: Buffer.concat(chunks).toString('utf8'),
            });
          });
        },
      );
      request.on('timeout', () =>
        request.destroy(new RpcError(RpcErrorCode.FORBIDDEN, 'egress: timed out')),
      );
      request.on('error', (err) =>
        reject(
          err instanceof RpcError
            ? err
            : new RpcError(RpcErrorCode.FORBIDDEN, `egress: request failed: ${err.message}`),
        ),
      );
      if (bodyBuf) request.write(bodyBuf);
      request.end();
    });
  }
}

function sanitizeHeaders(headers?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (!FORBIDDEN_REQUEST_HEADERS.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

/** Response headers a module must never receive (auth/session bleed from the upstream). */
const STRIPPED_RESPONSE_HEADERS = new Set(['set-cookie', 'set-cookie2']);

function flattenHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (STRIPPED_RESPONSE_HEADERS.has(k.toLowerCase())) continue;
    if (Array.isArray(v)) out[k] = v.join(', ');
    else if (v != null) out[k] = v;
  }
  return out;
}
