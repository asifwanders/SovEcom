/**
 * SSRF guard for subscriber URLs.
 *
 * Blocks delivery to loopback / private / link-local / unique-local / cloud-metadata addresses,
 * for both IPv4 and IPv6 (incl. IPv4-mapped IPv6). Enforced at TWO points:
 *   1. `assertSafeWebhookUrl` at subscription-create (scheme + resolve-and-check every A/AAAA).
 *   2. `safeLookup` at delivery connect time — re-resolves and re-checks, so a hostname that later
 *      re-points to an internal IP (DNS-rebinding/TOCTOU) is refused at the socket layer.
 *
 * Escape hatches (default OFF, dev/test only): `WEBHOOK_ALLOW_INSECURE` permits `http://`;
 * `WEBHOOK_ALLOW_PRIVATE_HOSTS` permits private/loopback targets (so the integration test can hit a
 * local server). Production leaves both unset.
 */
import { BadRequestException } from '@nestjs/common';
import { isIP, type LookupFunction } from 'node:net';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { promisify } from 'node:util';

const lookupAll = promisify(dnsLookup);

// The escape hatches only work in an EXPLICIT dev/test env (allowlist, not a "not production"
// denylist): a missing/`staging`/typo'd NODE_ENV leaves SSRF protection ON, so the flags can never
// silently weaken a non-dev deployment.
const devOrTest = (): boolean =>
  process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development';
const allowPrivate = (): boolean =>
  devOrTest() && process.env.WEBHOOK_ALLOW_PRIVATE_HOSTS === 'true';
const allowInsecure = (): boolean => devOrTest() && process.env.WEBHOOK_ALLOW_INSECURE === 'true';

/** True if an IPv4 dotted-quad is in a blocked (non-public) range — malformed input is blocked. */
function ipv4Blocked(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255))
    return true;
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 + 192.0.2.0/24
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking 198.18.0.0/15
  if (a >= 224) return true; // multicast + reserved (224.0.0.0/4, 240.0.0.0/4)
  return false;
}

/**
 * Parse any valid IPv6 textual form (compressed `::`, expanded, zone id, or with a trailing
 * embedded IPv4 like `::ffff:127.0.0.1`) to its 16 bytes. Returns null if unparseable.
 */
function ipv6ToBytes(ip: string): number[] | null {
  let s = ip.toLowerCase().split('%')[0]!; // drop any zone id
  // Convert a trailing dotted-quad (`…:1.2.3.4`) into two hex groups so `::` handling is uniform.
  const dq = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (dq) {
    const o = [dq[2]!, dq[3]!, dq[4]!, dq[5]!].map(Number);
    if (o.some((x) => x > 255)) return null;
    const h1 = ((o[0]! << 8) | o[1]!).toString(16);
    const h2 = ((o[2]! << 8) | o[3]!).toString(16);
    s = `${dq[1]}${h1}:${h2}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null;
  let groups: string[];
  if (tail === null) {
    groups = head;
  } else {
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    groups = [...head, ...Array<string>(missing).fill('0'), ...tail];
  }
  if (groups.length !== 8) return null;
  const bytes: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    const v = parseInt(g, 16);
    bytes.push((v >> 8) & 0xff, v & 0xff);
  }
  return bytes;
}

/** True if an IPv6 address is loopback/unspecified/ULA/link-local, or wraps a blocked IPv4. */
function ipv6Blocked(ip: string): boolean {
  const b = ipv6ToBytes(ip);
  if (!b) return true; // unparseable → block (fail closed)
  const embeddedV4 = (): string => `${b[12]}.${b[13]}.${b[14]}.${b[15]}`;
  const firstZero = (n: number): boolean => b.slice(0, n).every((x) => x === 0);

  // IPv4-mapped ::ffff:0:0/96 — any textual form (::ffff:127.0.0.1, ::ffff:7f00:1, expanded…).
  if (firstZero(10) && b[10] === 0xff && b[11] === 0xff) return ipv4Blocked(embeddedV4());
  // NAT64 well-known prefix 64:ff9b::/96 — wraps a v4 destination.
  if (
    b[0] === 0x00 &&
    b[1] === 0x64 &&
    b[2] === 0xff &&
    b[3] === 0x9b &&
    b.slice(4, 12).every((x) => x === 0)
  ) {
    return ipv4Blocked(embeddedV4());
  }
  // IPv4-compatible ::a.b.c.d (deprecated) — first 12 bytes zero, but NOT :: or ::1.
  if (firstZero(12) && !(b[12] === 0 && b[13] === 0 && b[14] === 0 && b[15]! <= 1)) {
    return ipv4Blocked(embeddedV4());
  }
  if (firstZero(15) && b[15] === 1) return true; // ::1 loopback
  if (b.every((x) => x === 0)) return true; // :: unspecified
  if ((b[0]! & 0xfe) === 0xfc) return true; // fc00::/7 unique-local
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return true; // fe80::/10 link-local
  return false;
}

/** True if `ip` (v4 or v6 literal) must NOT be a webhook target. Non-IP input is blocked. */
export function isBlockedAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return ipv4Blocked(ip);
  if (kind === 6) return ipv6Blocked(ip);
  return true;
}

/**
 * Validate a subscriber URL at create time: must be https (or http with the insecure flag), and
 * every address the host resolves to must be public. Throws BadRequestException on any violation.
 */
export async function assertSafeWebhookUrl(rawUrl: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BadRequestException('Invalid webhook URL');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && allowInsecure())) {
    throw new BadRequestException('Webhook URL must use https');
  }
  if (allowPrivate()) return; // dev/test escape hatch

  const host = url.hostname;
  if (isIP(host)) {
    if (isBlockedAddress(host))
      throw new BadRequestException('Webhook URL resolves to a blocked address');
    return;
  }
  let addrs: LookupAddress[];
  try {
    addrs = await lookupAll(host, { all: true });
  } catch {
    throw new BadRequestException('Webhook host does not resolve');
  }
  if (addrs.length === 0) throw new BadRequestException('Webhook host does not resolve');
  for (const a of addrs) {
    if (isBlockedAddress(a.address)) {
      throw new BadRequestException('Webhook URL resolves to a blocked address');
    }
  }
}

/**
 * True if `hostname` is an IP LITERAL that must not be connected to. Node's http(s) `lookup` option
 * is NOT invoked for literal IPs, so {@link safeLookup} never sees them — the delivery path must
 * call this explicitly before connecting. Names return false (safeLookup covers them). Honours the
 * private-hosts dev/test flag.
 */
export function isLiteralAddressBlocked(hostname: string): boolean {
  if (allowPrivate()) return false;
  if (isIP(hostname)) return isBlockedAddress(hostname);
  return false;
}

/**
 * A `net.LookupFunction` for the http(s) request `lookup` option. Re-resolves the host at CONNECT
 * time and refuses the connection (error callback) if any resolved address is blocked — defeating
 * DNS-rebinding. With the private-hosts flag set, the block check is skipped (dev/test).
 */
export const safeLookup: LookupFunction = (hostname, _options, callback) => {
  dnsLookup(hostname, { all: true }, (err, addresses: LookupAddress[]) => {
    if (err) return callback(err, '', 0);
    if (addresses.length === 0) return callback(new Error('SSRF: host does not resolve'), '', 0);
    if (!allowPrivate()) {
      for (const a of addresses) {
        if (isBlockedAddress(a.address)) return callback(new Error('SSRF: blocked address'), '', 0);
      }
    }
    const chosen = addresses[0]!;
    callback(null, chosen.address, chosen.family);
  });
};
