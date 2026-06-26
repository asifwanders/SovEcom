/**
 * TwoFactorEnrollmentService.confirm UNIT tests.
 * SECURITY-CRITICAL.
 *
 * Two regressions:
 *  - the confirm code must be BURNED through the same atomic Redis NX replay claim
 *    every other accepted TOTP code uses (a confirm code cannot be replayed);
 *  - the documented enroll TTL (`totpEnrollStartedAt`) must be enforced: a null or
 *    stale (> 15 min) pending window rejects the confirm (fail closed).
 *
 * The real {@link TwoFactorService.claimUsedCode} is exercised over an in-memory
 * Redis fake (the same shape as two-factor.service.spec) so the burn is end-to-end.
 */
import { authenticator } from 'otplib';
import { TwoFactorEnrollmentService } from './two-factor-enrollment.service';
import { TwoFactorService } from './two-factor.service';

/** Minimal Redis fake: models SET ... NX EX (returns 'OK' on first set, null after). */
class FakeRedis {
  private store = new Map<string, string>();
  async set(key: string, value: string, ..._args: unknown[]): Promise<'OK' | null> {
    if (this.store.has(key)) return null;
    this.store.set(key, value);
    return 'OK';
  }
}

/** AEAD stub: identity codec so the test controls the "decrypted" pending secret. */
const fakeAead = {
  encrypt: (pt: string, _aad: string): string => `enc(${pt})`,
  decrypt: (blob: string, _aad: string): string => blob.replace(/^enc\(|\)$/g, ''),
};

const SECRET = authenticator.generateSecret();

function makeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-7000-8000-000000000001',
    tenantId: '00000000-0000-7000-8000-0000000000aa',
    totpSecretPending: `enc(${SECRET})`,
    totpEnrollStartedAt: new Date(), // fresh window by default
    ...overrides,
  } as never;
}

function makeService(redis = new FakeRedis()): {
  svc: TwoFactorEnrollmentService;
  updates: jest.Mock;
} {
  const updates = jest.fn();
  // Drizzle update chain: .update().set().where() — capture the .set() payload.
  const db = {
    db: {
      update: () => ({
        set: (vals: unknown) => ({
          where: async () => {
            updates(vals);
          },
        }),
      }),
    },
  };
  const twoFactor = new TwoFactorService(redis as never, fakeAead as never);
  const audit = { record: jest.fn(async () => undefined) };
  const passwords = { verify: jest.fn() };

  const svc = new TwoFactorEnrollmentService(
    db as never,
    fakeAead as never,
    passwords as never,
    twoFactor,
    audit as never,
  );
  return { svc, updates };
}

const CTX = { ip: '127.0.0.1', userAgent: 'jest' };

describe('TwoFactorEnrollmentService.confirm — replay + TTL (SECURITY-CRITICAL)', () => {
  it('activates 2FA on a fresh, valid confirm', async () => {
    const { svc, updates } = makeService();
    const code = authenticator.generate(SECRET);
    expect(await svc.confirm(makeUser(), code, CTX)).toBe(true);
    expect(updates).toHaveBeenCalledWith(expect.objectContaining({ totpEnabled: true }));
  });

  it('BURNS the confirm code: the same code cannot be replayed', async () => {
    const redis = new FakeRedis();
    const code = authenticator.generate(SECRET);

    // First confirm succeeds and burns the matched step.
    const first = makeService(redis);
    expect(await first.svc.confirm(makeUser(), code, CTX)).toBe(true);

    // A second confirm with the SAME code (same step) loses the NX race -> rejected.
    const second = makeService(redis);
    expect(await second.svc.confirm(makeUser(), code, CTX)).toBe(false);
    expect(second.updates).not.toHaveBeenCalled();
  });

  it('REJECTS a stale pending secret (totpEnrollStartedAt older than the TTL)', async () => {
    const { svc, updates } = makeService();
    const code = authenticator.generate(SECRET);
    const stale = makeUser({
      totpEnrollStartedAt: new Date(Date.now() - 16 * 60 * 1000), // 16 min ago > 15 min TTL
    });
    expect(await svc.confirm(stale, code, CTX)).toBe(false);
    expect(updates).not.toHaveBeenCalled();
  });

  it('REJECTS when totpEnrollStartedAt is null (no enrollment window)', async () => {
    const { svc, updates } = makeService();
    const code = authenticator.generate(SECRET);
    expect(await svc.confirm(makeUser({ totpEnrollStartedAt: null }), code, CTX)).toBe(false);
    expect(updates).not.toHaveBeenCalled();
  });
});
