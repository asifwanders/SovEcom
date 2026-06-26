/**
 * GuestTokenService (SECURITY-CRITICAL).
 *
 * Mints and verifies the signed `sov_guest` httpOnly cookie that gives anonymous storefront
 * visitors a stable, tenant-scoped identity. The identity is used ONLY for low-sensitivity
 * personalization (recently-viewed, guest wishlist) -- it never grants access to orders,
 * addresses, payment methods, or any account data.
 *
 * TOKEN SHAPE (compact, not JWT to avoid confusion with customer JWTs):
 *   base64url(JSON { guestId: UUID, tenantId: string, iat: number }) + "." + base64url(HMAC-SHA256)
 *
 * SIGNING: HMAC-SHA256 over the payload with STORAGE_SIGNING_SECRET. A dedicated
 * GUEST_TOKEN_SECRET is preferred when set; STORAGE_SIGNING_SECRET is the safe fallback so
 * no new REQUIRED env var is introduced (the boot validator already enforces its strength in
 * production). In dev the storage-signing-secret dev default is used automatically.
 *
 * COOKIE ATTRIBUTES:
 *   name:     sov_guest
 *   httpOnly: true      -- JS cannot read the raw token (reduces XSS attack surface)
 *   secure:   true(prod)-- HTTPS only in production
 *   sameSite: 'lax'     -- rides on top-level navigations; 'strict' would break cross-site
 *                          links back to the storefront; 'none' would require Secure always.
 *                          Lax is the right balance for a personalization cookie.
 *   domain:   derived via PSL (eTLD+1) from STORE_ORIGIN, or from GUEST_COOKIE_DOMAIN when
 *             set explicitly. On shared/public-suffix hosts (*.herokuapp.com, bare PSL entry)
 *             or IPs/localhost, Domain is omitted (host-only cookie). See resolveGuestCookieDomain.
 *   maxAge:   1 year (personalization cookie -- low sensitivity, long horizon acceptable)
 *   path:     / (all store routes need it; not scoped to /store/v1 because Caddy may
 *             rewrite paths)
 *
 * TENANT ISOLATION: guestId is bound to a tenantId in the signed payload. The proxy verifies
 * both and rejects a token whose tenantId does not match the current request's tenant. A
 * guest from tenant A can never be resolved as a guest on tenant B.
 *
 * NO PII: the token payload contains only a random UUID (guestId), tenantId, and issued-at
 * timestamp. No email, no IP, no device fingerprint is ever stored in the token.
 */
import { createHmac, randomUUID, timingSafeEqual as nodeCryptoTimingSafeEqual } from 'node:crypto';
import { parse as parseTld } from 'tldts';
import {
  resolveStorageSigningSecret,
  STORAGE_SIGNING_SECRET_DEV_DEFAULT,
} from '../../storage/storage-signing-secret';

/** Cookie name. Must not collide with any existing cookie. */
export const GUEST_COOKIE_NAME = 'sov_guest';

/** 1-year maxAge in milliseconds for the personalization cookie. */
export const GUEST_COOKIE_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

/** Opaque guest token payload (signed over this structure). */
interface GuestTokenPayload {
  guestId: string;
  tenantId: string;
  /** Issued-at timestamp (milliseconds since epoch). Used for expiry validation. */
  iat: number;
}

/**
 * Resolve the HMAC signing secret for guest tokens. Prefers the dedicated
 * GUEST_TOKEN_SECRET when set (allows key rotation independent of storage), falls back to
 * STORAGE_SIGNING_SECRET. Both must meet the same 256-bit minimum in production (the boot
 * validator already enforces STORAGE_SIGNING_SECRET strength).
 *
 * GUEST_TOKEN_SECRET validation: rejects secrets shorter than 32 bytes, all-whitespace, or
 * the storage dev default. A weak/invalid dedicated secret is NOT silently accepted — the
 * fallback is used instead so an operator typo never silently degrades security.
 */
function resolveGuestSigningSecret(): string {
  const dedicated = process.env['GUEST_TOKEN_SECRET'];
  if (dedicated !== undefined && dedicated !== '') {
    // Apply the same strength checks as STORAGE_SIGNING_SECRET: min 32 bytes, not all-whitespace,
    // not the well-known dev default.
    const isWeak =
      Buffer.byteLength(dedicated, 'utf8') < 32 ||
      dedicated.trim().length === 0 ||
      dedicated === STORAGE_SIGNING_SECRET_DEV_DEFAULT;
    if (!isWeak) {
      return dedicated;
    }
    // Weak dedicated secret: fall through to the validated fallback (never silently accept).
  }
  // Fallback: reuse the already-validated STORAGE_SIGNING_SECRET.
  return resolveStorageSigningSecret(process.env);
}

/**
 * Encode a payload to the wire format: base64url(JSON payload) + "." + base64url(HMAC-SHA256).
 * The dot separator is safe because base64url uses no dots.
 */
function encode(payload: GuestTokenPayload): string {
  const secret = resolveGuestSigningSecret();
  const payloadJson = JSON.stringify(payload);
  const payloadB64 = Buffer.from(payloadJson, 'utf8').toString('base64url');
  const sig = createHmac('sha256', secret).update(payloadB64).digest('base64url');
  return `${payloadB64}.${sig}`;
}

/**
 * Verify a guest token and return its payload. Returns null on any failure (invalid format,
 * wrong signature, tampered tenantId) -- never throws. A null result means "no guest identity"
 * and must be treated as anonymous (mint a fresh cookie).
 *
 * Constant-time comparison is used for the signature to prevent timing side-channels.
 */
function verify(raw: string, expectedTenantId: string): GuestTokenPayload | null {
  const dot = raw.indexOf('.');
  if (dot <= 0 || dot === raw.length - 1) return null;

  const payloadB64 = raw.slice(0, dot);
  const receivedSig = raw.slice(dot + 1);

  // Recompute the expected signature.
  let secret: string;
  try {
    secret = resolveGuestSigningSecret();
  } catch {
    return null;
  }

  const expectedSig = createHmac('sha256', secret).update(payloadB64).digest('base64url');

  // Constant-time compare to prevent timing attacks on the HMAC.
  // HMAC-SHA256 base64url output is always 43 chars; length mismatch → reject without leaking.
  const bufReceived = Buffer.from(receivedSig, 'utf8');
  const bufExpected = Buffer.from(expectedSig, 'utf8');
  if (bufReceived.length !== bufExpected.length) return null;
  if (!nodeCryptoTimingSafeEqual(bufReceived, bufExpected)) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  const rec = payload as Record<string, unknown>;
  if (
    typeof payload !== 'object' ||
    payload === null ||
    typeof rec.guestId !== 'string' ||
    typeof rec.tenantId !== 'string' ||
    typeof rec.iat !== 'number'
  ) {
    return null;
  }

  const p = payload as GuestTokenPayload;

  // TENANT ISOLATION: reject a token from a different tenant.
  if (p.tenantId !== expectedTenantId) return null;

  // Validate guestId is a non-empty string (UUID format is not enforced -- opaque).
  if (p.guestId.length === 0 || p.guestId.length > 100) return null;

  // TOKEN EXPIRY: reject tokens older than the max-age. Tokens without iat were rejected above.
  if (Date.now() - p.iat > GUEST_COOKIE_MAX_AGE_MS) return null;

  return p;
}

/**
 * Derive the cookie `domain` attribute for the `sov_guest` cookie.
 *
 * Resolution order:
 *   1. GUEST_COOKIE_DOMAIN env — if set, use verbatim (operator-controlled override, e.g. for
 *      shared hosting where auto-detection cannot determine the correct scope).
 *   2. STORE_ORIGIN env — parse the hostname and resolve the eTLD+1 (registrable domain) via the
 *      Public Suffix List (tldts). Setting Domain=<eTLD+1> lets the cookie span the merchant's
 *      own subdomains (storefront.example.com ↔ api.example.com) without leaking to unrelated
 *      tenants on shared hosting (*.herokuapp.com, *.sovecom.cloud, etc.).
 *   3. Fallback — return undefined (host-only cookie). The browser restricts the cookie to the
 *      exact request host. Cross-subdomain guest identity then requires GUEST_COOKIE_DOMAIN.
 *
 * Cases that always return undefined (host-only):
 *   - Localhost / loopback
 *   - Bare IPv4 or IPv6 address
 *   - The host itself IS a public suffix (e.g. "com", "co.uk") — setting Domain= to a PSL
 *     entry would broadcast the cookie to every registrant under that suffix.
 *   - tldts cannot determine a registrable domain (returns null/empty).
 *
 * Examples (STORE_ORIGIN path, no GUEST_COOKIE_DOMAIN override):
 *   https://example.com        → example.com   (merchant owns eTLD+1)
 *   https://shop.example.com   → example.com   (eTLD+1, covers api.example.com too)
 *   https://tenant.sovecom.cloud → undefined   (sovecom.cloud is a PSL public suffix entry;
 *                                               use GUEST_COOKIE_DOMAIN=tenant.sovecom.cloud)
 *   https://myapp.herokuapp.com → undefined    (shared suffix; host-only is the safe default)
 *   https://localhost           → undefined    (localhost)
 *   https://192.168.1.1         → undefined    (IP)
 */
export function resolveGuestCookieDomain(): string | undefined {
  // 1. Operator-controlled explicit override — still validated through the PSL so a typo
  //    (e.g. ".cloud", "co.uk", "herokuapp.com") can't silently over-scope the cookie across
  //    a whole public/shared suffix. An invalid override falls through to auto-derivation.
  const override = process.env['GUEST_COOKIE_DOMAIN'];
  if (override && override.trim().length > 0) {
    const cand = override.trim().replace(/^\./, '').toLowerCase();
    const p = parseTld(cand, { allowPrivateDomains: true });
    const isRegistrable =
      cand.includes('.') &&
      !!p.domain &&
      !p.isPrivate && // reject private/shared suffixes (herokuapp.com, vercel.app, …)
      (cand === p.domain || cand.endsWith(`.${p.domain}`)); // the registrable domain or a subdomain of it
    if (isRegistrable) return cand;
    // else: ignore the footgun value and fall through to STORE_ORIGIN-based derivation.
  }

  // 2. Derive from STORE_ORIGIN via PSL.
  const origin = process.env['STORE_ORIGIN'];
  if (!origin) return undefined;

  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return undefined;
  }

  // Reject localhost and bare IPv4/IPv6 immediately.
  if (host === 'localhost' || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[')) {
    return undefined;
  }

  // Parse with allowPrivateDomains: true so shared-hosting domains (herokuapp.com, vercel.app,
  // netlify.app, etc.) are flagged as `isPrivate: true` rather than resolving to the shared
  // eTLD+1. Without this flag, tldts treats *.herokuapp.com as ICANN and returns 'herokuapp.com'
  // as the registrable domain (which would leak the cookie across all Heroku tenants).
  const parsed = parseTld(host, { allowPrivateDomains: true });

  // No registrable domain could be determined (IP, bare TLD, undeterminable).
  if (!parsed.domain) return undefined;

  // Host is on a shared/private-PSL suffix (*.herokuapp.com, *.vercel.app, etc.).
  // Setting Domain= to the registrable domain would scope the cookie across all tenants
  // on that shared infrastructure. Return undefined (host-only); operators must set
  // GUEST_COOKIE_DOMAIN explicitly for cross-subdomain identity on shared hosting.
  if (parsed.isPrivate) return undefined;

  // Sanity: domain must contain at least one dot (already guaranteed by PSL, but be explicit).
  if (!parsed.domain.includes('.')) return undefined;

  return parsed.domain;
}

/** Mint a fresh signed guest token for a new anonymous visitor. */
export function mintGuestToken(tenantId: string): string {
  const guestId = randomUUID();
  return encode({ guestId, tenantId, iat: Date.now() });
}

/**
 * Verify a raw guest cookie value against the current tenant. Returns the guestId (opaque
 * UUID) on success, or null when the token is missing, malformed, tampered, or from another
 * tenant. Callers should mint a fresh token on null.
 */
export function verifyGuestToken(raw: string | undefined, tenantId: string): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const payload = verify(raw, tenantId);
  return payload ? payload.guestId : null;
}
