/**
 * AuthService unit tests (SECURITY-CRITICAL).
 *
 * Regression coverage for the 2FA brute-force hardening: verify2fa must throttle
 * the second factor PER ACCOUNT (independent of IP / challenge), and a failed TOTP
 * must count on the same failed_attempts / locked_until lockout path that wrong
 * passwords use — so an attacker who already holds the password cannot brute the
 * 6-digit TOTP by re-minting challenges and rotating source IPs.
 */
import { AuthService } from './auth.service';
import { RateLimitService } from './rate-limit.service';

interface FakeUser {
  id: string;
  tenantId: string;
  email: string;
  passwordHash: string;
  totpEnabled: boolean;
  totpSecret: string | null;
  role: string;
  tokenVersion: number;
  failedAttempts: number;
  lockedUntil: Date | null;
}

/**
 * Minimal in-memory rate limiter mirroring RateLimitService's fixed-window /
 * fail-closed contract (count <= limit ⇒ allowed). Per-key counters, no IP in
 * the key — so the test can assert IP rotation does NOT widen the budget.
 */
class FakeRateLimit {
  private readonly counts = new Map<string, number>();
  async check(
    key: string,
    options: { limit?: number; windowSeconds?: number } = {},
  ): Promise<{ allowed: boolean; count: number; degraded: boolean }> {
    const limit = options.limit ?? 10;
    const next = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, next);
    return { allowed: next <= limit, count: next, degraded: false };
  }
}

function makeUser(overrides: Partial<FakeUser> = {}): FakeUser {
  return {
    id: 'user-1',
    tenantId: 'tenant-1',
    email: 'admin@example.com',
    passwordHash: 'hash',
    totpEnabled: true,
    totpSecret: 'SECRET',
    role: 'admin',
    tokenVersion: 0,
    failedAttempts: 0,
    lockedUntil: null,
    ...overrides,
  };
}

describe('AuthService.verify2fa (2FA brute-force hardening)', () => {
  let user: FakeUser;
  let rateLimit: FakeRateLimit;
  let twoFactorOk: boolean;
  let userUpdates: number;
  let database: { db: unknown };
  let service: AuthService;

  beforeEach(() => {
    user = makeUser();
    rateLimit = new FakeRateLimit();
    twoFactorOk = false;
    userUpdates = 0;

    // Drizzle-shaped fake: select(...).from().where().limit() resolves to [user];
    // update(...).set().where() bumps failed_attempts / locked_until on the user.
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => (user ? [user] : []),
          }),
        }),
      }),
      update: () => ({
        set: (patch: Partial<FakeUser>) => ({
          where: async () => {
            userUpdates += 1;
            if (typeof patch.failedAttempts === 'number') {
              user.failedAttempts = patch.failedAttempts;
            }
            if ('lockedUntil' in patch && patch.lockedUntil != null) {
              user.lockedUntil = new Date(Date.now() + 15 * 60 * 1000);
            }
          },
        }),
      }),
    };
    database = { db };

    const challenges = {
      // Each call mints a fresh challenge consumption — models an attacker re-minting
      // a new challenge per attempt. IP is whatever the caller passes (rotated below).
      consume: async (_challengeId: string, _ip: string) => ({
        userId: user.id,
        tenantId: user.tenantId,
      }),
    };
    const twoFactor = { verify: async () => twoFactorOk };
    const audit = { record: async () => undefined };

    service = new AuthService(
      database as never,
      {} as never, // tokens
      {} as never, // passwords
      twoFactor as never,
      challenges as never,
      rateLimit as unknown as RateLimitService,
      audit as never,
    );
  });

  it('per-account 2FA limit fires regardless of challenge/IP rotation', async () => {
    // 10 wrong-code attempts, each a fresh challenge from a DIFFERENT source IP.
    for (let i = 0; i < 10; i++) {
      const res = await service.verify2fa('challenge-' + i, '000000', { ip: `10.0.0.${i}` });
      expect(res).toBeNull();
    }
    // The 11th — STILL with a fresh challenge + new IP — must be blocked by the
    // per-account throttle BEFORE the code is ever checked. Even a correct code
    // would not succeed here.
    twoFactorOk = true;
    const blocked = await service.verify2fa('challenge-final', '123456', { ip: '203.0.113.9' });
    expect(blocked).toBeNull();
  });

  it('a failed TOTP increments failed_attempts (shared lockout path)', async () => {
    const before = user.failedAttempts;
    await service.verify2fa('challenge-x', '000000', { ip: '10.0.0.1' });
    expect(user.failedAttempts).toBe(before + 1);
    expect(userUpdates).toBeGreaterThan(0);
  });

  it('a soft-locked account cannot guess TOTP even with budget remaining', async () => {
    user.lockedUntil = new Date(Date.now() + 5 * 60 * 1000);
    twoFactorOk = true; // even a correct code must be refused while locked
    const res = await service.verify2fa('challenge-x', '123456', { ip: '10.0.0.1' });
    expect(res).toBeNull();
  });
});

describe('Z5 dead-code: enroll-2fa.dto must not exist', () => {
  it('enroll-2fa.dto.ts file must not be present', () => {
    expect(() => require('../dto/enroll-2fa.dto')).toThrow();
  });
});
