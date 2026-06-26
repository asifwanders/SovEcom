/**
 * GuestTokenService (SECURITY-CRITICAL).
 *
 * Mints and verifies the signed `sov_guest` httpOnly cookie that gives anonymous storefront
 * visitors a stable, tenant-scoped identity. The identity is used ONLY for low-sensitivity
 * personalization (recently-viewed, guest wishlist) -- it never grants access to orders,
 * addresses, payment methods, or any account data.
 *
 * TOKEN SHAPE (compact, not JWT to avoid confusion with customer JWTs):
 *   base64url(JSON { guestId: UUID, tenantId: string }) + "." + base64url(HMAC-SHA256)
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
 *   domain:   derived from STORE_ORIGIN env (e.g. STORE_ORIGIN=https://example.com
 *             -> domain=.example.com) so the cookie is sent from the storefront
 *             (example.com) to the API (api.example.com) on credentialed cross-origin
 *             fetches (credentials:'include'). When STORE_ORIGIN is not set (dev/test)
 *             no domain attribute is set (localhost-scoped).
 *   maxAge:   1 year (personalization cookie -- low sensitivity, long horizon acceptable)
 *   path:     / (all store routes need it; not scoped to /store/v1 because Caddy may
 *             rewrite paths)
 *
 * TENANT ISOLATION: guestId is bound to a tenantId in the signed payload. The proxy verifies
 * both and rejects a token whose tenantId does not match the current request's tenant. A
 * guest from tenant A can never be resolved as a guest on tenant B.
 *
 * NO PII: the token payload contains only a random UUID (guestId) and tenantId. No email,
 * no IP, no device fingerprint is ever stored in the token.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { resolveStorageSigningSecret } from '../../storage/storage-signing-secret';

/** Cookie name. Must not collide with any existing cookie. */
export const GUEST_COOKIE_NAME = 'sov_guest';

/** 1-year maxAge in milliseconds for the personalization cookie. */
export const GUEST_COOKIE_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

/** Opaque guest token payload (signed over this structure). */
interface GuestTokenPayload {
  guestId: string;
  tenantId: string;
}

/**
 * Resolve the HMAC signing secret for guest tokens. Prefers the dedicated
 * GUEST_TOKEN_SECRET when set (allows key rotation independent of storage), falls back to
 * STORAGE_SIGNING_SECRET. Both must meet the same 256-bit minimum in production (the boot
 * validator already enforces STORAGE_SIGNING_SECRET strength).
 */
function resolveGuestSigningSecret(): string {
  const dedicated = process.env['GUEST_TOKEN_SECRET'];
  if (dedicated && dedicated.length >= 32) {
    return dedicated;
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
  if (!timingSafeEqual(receivedSig, expectedSig)) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (
    typeof payload !== 'object' ||
    payload === null ||
    typeof (payload as Record<string, unknown>).guestId !== 'string' ||
    typeof (payload as Record<string, unknown>).tenantId !== 'string'
  ) {
    return null;
  }

  const p = payload as GuestTokenPayload;

  // TENANT ISOLATION: reject a token from a different tenant.
  if (p.tenantId !== expectedTenantId) return null;

  // Validate guestId is a non-empty string (UUID format is not enforced -- opaque).
  if (p.guestId.length === 0 || p.guestId.length > 100) return null;

  return p;
}

/**
 * Constant-time string comparison (prevents timing attacks on signature comparison).
 * Uses Buffer.from to work with arbitrary-length base64url strings.
 */
function timingSafeEqual(a: string, b: string): boolean {
  // Both must be equal length for a meaningful timing-safe compare. If lengths differ,
  // do the compare on padded buffers so we don't short-circuit on length alone.
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Still perform the compare to consume constant time on the longer; result is false.
    const shorter = bufA.length < bufB.length ? bufA : bufB;
    const longer = bufA.length < bufB.length ? bufB : bufA;
    // XOR shorter against first bytes of longer -- result is irrelevant but runs the loop.
    let acc = 0;
    for (let i = 0; i < shorter.length; i++) {
      acc |= shorter[i]! ^ longer[i]!;
    }
    void acc;
    return false;
  }
  // Same length -- standard timing-safe path.
  let diff = 0;
  for (let i = 0; i < bufA.length; i++) {
    diff |= bufA[i]! ^ bufB[i]!;
  }
  return diff === 0;
}

/**
 * Derive the cookie `domain` attribute from the STORE_ORIGIN env so the cookie is sent from
 * the storefront (e.g. example.com) to the API subdomain (e.g. api.example.com) via
 * credentials:'include'. Returns undefined when STORE_ORIGIN is not set (dev/test), which
 * means the browser uses the current request host (correct for localhost).
 *
 * Example: STORE_ORIGIN=https://example.com -> ".example.com"
 *          STORE_ORIGIN=https://www.example.com -> ".example.com"
 *          STORE_ORIGIN=https://localhost -> undefined (no domain attr)
 */
export function resolveGuestCookieDomain(): string | undefined {
  const origin = process.env['STORE_ORIGIN'];
  if (!origin) return undefined;
  try {
    const url = new URL(origin);
    const host = url.hostname;
    // Do not set a domain for localhost or bare IP addresses -- those must not have a domain attr.
    if (host === 'localhost' || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return undefined;
    // Strip leading www. to get the registrable domain, then prefix with dot to cover subdomains.
    const stripped = host.replace(/^www\./, '');
    return `.${stripped}`;
  } catch {
    return undefined;
  }
}

/** Mint a fresh signed guest token for a new anonymous visitor. */
export function mintGuestToken(tenantId: string): string {
  const guestId = randomUUID();
  return encode({ guestId, tenantId });
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
