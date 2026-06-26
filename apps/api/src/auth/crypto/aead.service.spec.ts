/**
 * AeadService UNIT tests (no DB/Redis, `jest.config.js`).
 * SECURITY-CRITICAL (AES-256-GCM, /data/master.key, AAD=userId).
 *
 * The TOTP secret is stored as AEAD ciphertext bound to the owning userId via the
 * GCM additional-authenticated-data. These tests pin the four invariants:
 *   - round-trip: decrypt(encrypt(pt, aad), aad) === pt.
 *   - TAMPER: flipping any byte of the ciphertext/tag makes decrypt THROW
 *     (authentication failure), never silently returns garbage.
 *   - WRONG AAD: decrypting with a different userId AAD THROWS (the blob is
 *     cryptographically bound to its user — a swapped row cannot be decrypted).
 *   - NO PLAINTEXT IN OUTPUT: the ciphertext never contains the plaintext bytes.
 *
 * The service loads a 32-byte key. To keep this a pure unit test we inject the
 * key directly rather than reading `/data/master.key` from disk.
 *
 * RED today: `./aead.service` does not exist yet, so this fails to COMPILE.
 */
import { AeadService } from './aead.service';

/** A fixed 32-byte (256-bit) key for deterministic unit runs. */
const KEY = Buffer.alloc(32, 7);

/**
 * The service reads its key from `/data/master.key` in prod, but exposes a
 * test/DI seam to supply the raw key. We construct via that seam.
 */
function makeService(): AeadService {
  return new AeadService(KEY);
}

const USER_A = '00000000-0000-7000-8000-00000000000a';
const USER_B = '00000000-0000-7000-8000-00000000000b';
const SECRET_PLAINTEXT = 'JBSWY3DPEHPK3PXP'; // a base32 TOTP secret

describe('AeadService — AES-256-GCM AAD-bound (unit, SECURITY-CRITICAL)', () => {
  let svc: AeadService;
  beforeEach(() => {
    svc = makeService();
  });

  it('round-trips: decrypt(encrypt(pt, aad), aad) === pt', () => {
    const blob = svc.encrypt(SECRET_PLAINTEXT, USER_A);
    expect(svc.decrypt(blob, USER_A)).toBe(SECRET_PLAINTEXT);
  });

  it('produces a fresh IV per call (two encrypts of the same pt differ)', () => {
    const a = svc.encrypt(SECRET_PLAINTEXT, USER_A);
    const b = svc.encrypt(SECRET_PLAINTEXT, USER_A);
    expect(a).not.toBe(b);
    // both still decrypt back to the same plaintext
    expect(svc.decrypt(a, USER_A)).toBe(SECRET_PLAINTEXT);
    expect(svc.decrypt(b, USER_A)).toBe(SECRET_PLAINTEXT);
  });

  it('TAMPER: a single mutated byte of the ciphertext makes decrypt THROW (auth fail)', () => {
    const blob = svc.encrypt(SECRET_PLAINTEXT, USER_A);
    // Mutate the last character of the blob (within the tag/ciphertext region).
    const bytes = Buffer.from(blob, 'base64');
    const last = bytes.length - 1;
    bytes[last] = bytes[last]! ^ 0xff;
    const tampered = bytes.toString('base64');
    expect(() => svc.decrypt(tampered, USER_A)).toThrow();
  });

  it('WRONG AAD: decrypting user A’s blob under user B’s id THROWS (cross-user binding)', () => {
    const blob = svc.encrypt(SECRET_PLAINTEXT, USER_A);
    expect(() => svc.decrypt(blob, USER_B)).toThrow();
  });

  it('NO PLAINTEXT IN OUTPUT: the serialized ciphertext never contains the secret bytes', () => {
    const blob = svc.encrypt(SECRET_PLAINTEXT, USER_A);
    // Neither the encoded blob nor its decoded raw bytes leak the plaintext.
    expect(blob).not.toContain(SECRET_PLAINTEXT);
    const raw = Buffer.from(blob, 'base64').toString('latin1');
    expect(raw).not.toContain(SECRET_PLAINTEXT);
  });
});

/**
 * MASTER_KEY production guard.
 *
 * Mirrors TokenService.getSigningKey / STORAGE_SIGNING_SECRET: in production a
 * known-default / weak `MASTER_KEY` (e.g. an all-zero base64 key) is a hard
 * failure. Dev/test boot normally. The guard runs only when the key is loaded
 * from the env (the raw 32-byte DI seam is for tests and stays unguarded).
 */
describe('AeadService — MASTER_KEY production guard (A3, SECURITY-CRITICAL)', () => {
  const ORIGINAL_ENV = { ...process.env };
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  /** A valid 32-byte key encoded base64 that is NOT a known default. */
  const STRONG_B64 = Buffer.alloc(32, 0x5a).toString('base64');
  /** A known-default all-zero 32-byte key (correct length, but trivially weak). */
  const ZERO_B64 = Buffer.alloc(32, 0).toString('base64');

  it('throws in production when MASTER_KEY is the all-zero default', () => {
    process.env.NODE_ENV = 'production';
    process.env.MASTER_KEY = ZERO_B64;
    expect(() => new AeadService()).toThrow(/MASTER_KEY/);
  });

  it('throws in production when MASTER_KEY is a known-default literal', () => {
    process.env.NODE_ENV = 'production';
    process.env.MASTER_KEY = 'changeme';
    expect(() => new AeadService()).toThrow(/MASTER_KEY/);
  });

  it('accepts a strong MASTER_KEY in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.MASTER_KEY = STRONG_B64;
    expect(() => new AeadService()).not.toThrow();
  });

  it('allows the all-zero key outside production (dev/test boot normally)', () => {
    process.env.NODE_ENV = 'test';
    process.env.MASTER_KEY = ZERO_B64;
    expect(() => new AeadService()).not.toThrow();
  });
});
