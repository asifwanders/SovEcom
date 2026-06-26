/**
 * GuestTokenService unit tests (SECURITY-CRITICAL).
 *
 * Tests: mint + verify round-trip, tamper detection, cross-tenant rejection, encoding
 * correctness, and cookie domain derivation.
 */
import {
  mintGuestToken,
  verifyGuestToken,
  resolveGuestCookieDomain,
  GUEST_COOKIE_NAME,
} from './guest-token.service';

const TENANT = 'tenant-abc-123';
const OTHER_TENANT = 'tenant-xyz-999';

// Set a test signing secret before each test.
let originalSecret: string | undefined;
let originalStoreOrigin: string | undefined;

beforeEach(() => {
  originalSecret = process.env['STORAGE_SIGNING_SECRET'];
  originalStoreOrigin = process.env['STORE_ORIGIN'];
  // 32+ byte test secret (satisfies the 256-bit minimum).
  process.env['STORAGE_SIGNING_SECRET'] = 'test-storage-signing-secret-32+chars-ok';
  delete process.env['GUEST_TOKEN_SECRET'];
});

afterEach(() => {
  if (originalSecret !== undefined) {
    process.env['STORAGE_SIGNING_SECRET'] = originalSecret;
  } else {
    delete process.env['STORAGE_SIGNING_SECRET'];
  }
  if (originalStoreOrigin !== undefined) {
    process.env['STORE_ORIGIN'] = originalStoreOrigin;
  } else {
    delete process.env['STORE_ORIGIN'];
  }
  delete process.env['GUEST_TOKEN_SECRET'];
});

describe('mintGuestToken + verifyGuestToken', () => {
  it('round-trip: a minted token verifies to a non-empty UUID', () => {
    const token = mintGuestToken(TENANT);
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(16);

    const guestId = verifyGuestToken(token, TENANT);
    expect(typeof guestId).toBe('string');
    expect(guestId!.length).toBeGreaterThan(0);
    // Should look like a UUID (not enforced, but expected from randomUUID).
    expect(guestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('two mints produce different guestIds', () => {
    const id1 = verifyGuestToken(mintGuestToken(TENANT), TENANT);
    const id2 = verifyGuestToken(mintGuestToken(TENANT), TENANT);
    expect(id1).not.toBe(id2);
  });

  it('returns null for undefined/empty input', () => {
    expect(verifyGuestToken(undefined, TENANT)).toBeNull();
    expect(verifyGuestToken('', TENANT)).toBeNull();
  });

  it('CROSS-TENANT REJECTION: a token from one tenant is rejected for another', () => {
    const token = mintGuestToken(TENANT);
    expect(verifyGuestToken(token, OTHER_TENANT)).toBeNull();
    // Same token verifies for the correct tenant.
    expect(verifyGuestToken(token, TENANT)).not.toBeNull();
  });

  it('TAMPER: flipping a byte in the payload invalidates the token', () => {
    const token = mintGuestToken(TENANT);
    const dot = token.indexOf('.');
    const payload = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    // Flip first char of payload.
    const tampered = (payload[0] === 'A' ? 'B' : 'A') + payload.slice(1) + '.' + sig;
    expect(verifyGuestToken(tampered, TENANT)).toBeNull();
  });

  it('TAMPER: flipping a byte in the signature invalidates the token', () => {
    const token = mintGuestToken(TENANT);
    const dot = token.indexOf('.');
    const payload = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const tamperedSig = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);
    expect(verifyGuestToken(payload + '.' + tamperedSig, TENANT)).toBeNull();
  });

  it('TAMPER: removing the signature yields null', () => {
    const token = mintGuestToken(TENANT);
    const payload = token.slice(0, token.indexOf('.'));
    expect(verifyGuestToken(payload, TENANT)).toBeNull();
    expect(verifyGuestToken(payload + '.', TENANT)).toBeNull();
  });

  it('TAMPER: a completely random string is rejected', () => {
    expect(verifyGuestToken('random.garbage.not-a-token', TENANT)).toBeNull();
    expect(verifyGuestToken('aGVsbG8=.d2FybGQ=', TENANT)).toBeNull();
  });

  it('WRONG SECRET: a token minted with one secret is rejected with another', () => {
    const token = mintGuestToken(TENANT);
    // Change the secret.
    process.env['STORAGE_SIGNING_SECRET'] = 'different-storage-signing-secret-32chars';
    expect(verifyGuestToken(token, TENANT)).toBeNull();
  });

  it('uses GUEST_TOKEN_SECRET when set (preferred over STORAGE_SIGNING_SECRET)', () => {
    process.env['GUEST_TOKEN_SECRET'] = 'dedicated-guest-token-secret-32chars-ok!';
    const token = mintGuestToken(TENANT);
    const id = verifyGuestToken(token, TENANT);
    expect(id).not.toBeNull();

    // Without the dedicated secret but with the fallback, the token should fail.
    delete process.env['GUEST_TOKEN_SECRET'];
    expect(verifyGuestToken(token, TENANT)).toBeNull();
  });

  it('cookie name constant is the expected value', () => {
    expect(GUEST_COOKIE_NAME).toBe('sov_guest');
  });
});

describe('resolveGuestCookieDomain', () => {
  it('returns undefined when STORE_ORIGIN is not set', () => {
    delete process.env['STORE_ORIGIN'];
    expect(resolveGuestCookieDomain()).toBeUndefined();
  });

  it('returns undefined for localhost', () => {
    process.env['STORE_ORIGIN'] = 'https://localhost';
    expect(resolveGuestCookieDomain()).toBeUndefined();
  });

  it('returns undefined for bare IP', () => {
    process.env['STORE_ORIGIN'] = 'https://192.168.1.1';
    expect(resolveGuestCookieDomain()).toBeUndefined();
  });

  it('returns .example.com for https://example.com', () => {
    process.env['STORE_ORIGIN'] = 'https://example.com';
    expect(resolveGuestCookieDomain()).toBe('.example.com');
  });

  it('strips www. prefix: https://www.example.com -> .example.com', () => {
    process.env['STORE_ORIGIN'] = 'https://www.example.com';
    expect(resolveGuestCookieDomain()).toBe('.example.com');
  });

  it('handles subdomain correctly: https://shop.example.com -> .shop.example.com', () => {
    process.env['STORE_ORIGIN'] = 'https://shop.example.com';
    expect(resolveGuestCookieDomain()).toBe('.shop.example.com');
  });

  it('returns undefined for malformed STORE_ORIGIN', () => {
    process.env['STORE_ORIGIN'] = 'not-a-url';
    expect(resolveGuestCookieDomain()).toBeUndefined();
  });
});
