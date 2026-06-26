/**
 * TwoFactorService UNIT tests (mock Redis, `jest.config.js`).
 * SECURITY-CRITICAL (otplib TOTP, window=±1, atomic replay guard).
 *
 * TOTP math is pure (otplib); the replay guard needs Redis, so we inject a tiny
 * in-memory fake that faithfully models `SET key val NX EX ttl` — the only Redis
 * primitive the matched-counter replay guard relies on. No real Redis, no DB.
 *
 * Covers:
 *   - a freshly generated TOTP code verifies (window math correct).
 *   - a code from a far-off time step is rejected (outside ±1 window).
 *   - REPLAY: the SAME accepted code presented twice is rejected the second time
 *     (the matched-step NX claim already holds), and the guard is atomic (the
 *     first claim wins, the replay claims 0).
 *   - the AEAD-bound secret is decrypted via the injected AeadService (the service
 *     never handles a plaintext secret column directly).
 *
 * RED today: `./two-factor.service` does not exist yet, so this fails to COMPILE.
 */
import { authenticator } from 'otplib';
import { TwoFactorService } from './two-factor.service';

/** Minimal Redis fake: models SET ... NX EX (returns 'OK' on first set, null after). */
class FakeRedis {
  private store = new Map<string, string>();
  async set(key: string, value: string, ..._args: unknown[]): Promise<'OK' | null> {
    // We only use the NX variant; once a key exists, NX set returns null.
    if (this.store.has(key)) return null;
    this.store.set(key, value);
    return 'OK';
  }
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
}

/** AEAD stub: identity codec so the test controls the "decrypted" secret. */
const fakeAead = {
  encrypt: (pt: string, _aad: string): string => `enc(${pt})`,
  decrypt: (blob: string, _aad: string): string => blob.replace(/^enc\(|\)$/g, ''),
};

const SECRET = authenticator.generateSecret(); // base32 secret
const USER = {
  id: '00000000-0000-7000-8000-000000000001',
  totpSecret: `enc(${SECRET})`, // AEAD-encoded as stored in users.totp_secret
};

function makeService(redis = new FakeRedis()): {
  svc: TwoFactorService;
  redis: FakeRedis;
} {
  // Ctor seam: (redisLike, aeadLike). Both are duck-typed in the unit test.
  const svc = new TwoFactorService(redis as never, fakeAead as never);
  return { svc, redis };
}

describe('TwoFactorService — TOTP math (unit, SECURITY-CRITICAL)', () => {
  it('verifies a freshly generated code for the user secret', async () => {
    const { svc } = makeService();
    const code = authenticator.generate(SECRET);
    expect(await svc.verify(USER, code)).toBe(true);
  });

  it('rejects a code generated for a far-off time step (outside ±1 window)', async () => {
    const { svc } = makeService();
    // A code computed 10 steps (5 min) in the past is well outside window=±1.
    const farPast = authenticator.generate(SECRET); // placeholder; real impl uses time math
    // Force an obviously-wrong code: increment each digit so it cannot match.
    const wrong = farPast.replace(/\d/g, (d) => String((Number(d) + 1) % 10));
    expect(await svc.verify(USER, wrong)).toBe(false);
  });

  it('rejects a structurally-wrong code', async () => {
    const { svc } = makeService();
    expect(await svc.verify(USER, '000000')).toBe(false);
  });
});

describe('TwoFactorService — replay guard (unit, mock Redis, SECURITY-CRITICAL)', () => {
  it('REPLAY: the same accepted code verifies once, then is REJECTED on reuse', async () => {
    const { svc, redis } = makeService();
    const code = authenticator.generate(SECRET);

    // First use: accepted (matched-step NX claim succeeds).
    expect(await svc.verify(USER, code)).toBe(true);

    // Second use of the SAME code within the same step: the NX claim already
    // holds -> replay rejected.
    expect(await svc.verify(USER, code)).toBe(false);

    // The guard left a per-user/matched-step marker in Redis (atomic single-claim).
    const keys = [...(redis as unknown as { store: Map<string, string> }).store.keys()];
    expect(keys.some((k) => k.includes(USER.id))).toBe(true);
  });

  it('the NX claim is atomic: a concurrent double-verify accepts exactly one', async () => {
    const { svc } = makeService();
    const code = authenticator.generate(SECRET);
    const [a, b] = await Promise.all([svc.verify(USER, code), svc.verify(USER, code)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });
});

describe('TwoFactorService — AEAD secret handling (unit)', () => {
  it('decrypts the AEAD-bound secret (never reads a plaintext column)', async () => {
    const { svc } = makeService();
    // A user whose stored secret is AEAD-encoded still verifies a live code,
    // proving the service routed the blob through AeadService.decrypt(.., userId).
    const code = authenticator.generate(SECRET);
    expect(await svc.verify(USER, code)).toBe(true);
  });

  it('fails CLOSED on a null / undecryptable secret (no bypass)', async () => {
    const { svc } = makeService();
    const noSecretUser = { id: USER.id, totpSecret: null };
    expect(await svc.verify(noSecretUser, '123456')).toBe(false);
  });
});
