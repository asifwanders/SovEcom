/**
 * CustomerAuthService lockout unit tests (AUTH-CRITICAL — audit A1 / finding #2).
 *
 * The storefront login previously had ONLY an IP+email-keyed throttle (defeated by IP
 * rotation) and NO per-account counter. These tests pin the new account-keyed soft lock,
 * mirroring the admin precedent (AuthService): lock after N wrong passwords, stay locked
 * within the window, auto-unlock after it, the counter resets on success, and — the
 * critical anti-DoS invariant — a CORRECT password is NEVER blocked by an active lock and
 * clears it, so an attacker cannot lock a victim out of their own valid credential.
 *
 * Unit-level with a Drizzle-shaped fake DB (no live Postgres): `select(...)` returns the
 * current customer row; `update(...).set().where()` applies the failed_attempts /
 * locked_until patch back onto that row (translating the service's `now() + interval` sql
 * into a concrete future Date), exactly like the admin spec.
 */
import { CustomerAuthService } from './customer-auth.service';
import type { RateLimitService } from '../../auth/services/rate-limit.service';

const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const TENANT = '01900000-0000-7000-8000-000000000000';

interface FakeCustomer {
  id: string;
  tenantId: string;
  email: string;
  passwordHash: string | null;
  tokenVersion: number;
  failedAttempts: number;
  lockedUntil: Date | null;
}

/** Per-key fixed-window limiter, no IP coupling — high limit so it never gates here. */
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

function makeCustomer(overrides: Partial<FakeCustomer> = {}): FakeCustomer {
  return {
    id: 'cust-1',
    tenantId: TENANT,
    email: 'shopper@example.com',
    passwordHash: 'argon2-hash',
    tokenVersion: 0,
    failedAttempts: 0,
    lockedUntil: null,
    ...overrides,
  };
}

describe('CustomerAuthService — per-account soft lockout', () => {
  let customer: FakeCustomer | null;
  let rateLimit: FakeRateLimit;
  let passwordOk: boolean;
  let _updates: number;
  let service: CustomerAuthService;

  const ctx = { ip: '203.0.113.7', userAgent: 'jest' };

  beforeEach(() => {
    customer = makeCustomer();
    rateLimit = new FakeRateLimit();
    passwordOk = false;
    _updates = 0;

    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => (customer ? [customer] : []),
          }),
        }),
      }),
      update: () => ({
        set: (patch: Partial<FakeCustomer>) => ({
          where: async () => {
            _updates += 1;
            if (!customer) return;
            if (typeof patch.failedAttempts === 'number') {
              customer.failedAttempts = patch.failedAttempts;
            }
            // recordSuccess clears the lock (null); recordFailure trips it with an sql
            // `now() + make_interval(...)` object → translate to a concrete future Date.
            if ('lockedUntil' in patch) {
              customer.lockedUntil =
                patch.lockedUntil == null ? null : new Date(Date.now() + LOCKOUT_MS);
            }
          },
        }),
      }),
      insert: () => ({ values: async () => undefined }),
    };

    const passwords = {
      verify: async () => passwordOk,
      dummyVerify: async () => undefined,
    };
    const customerTokens = { issueAccessToken: async () => 'access-token' };
    const tokens = {
      issueRefreshToken: () => ({ familyId: 'fam-1', hash: 'h', plaintext: 'refresh-token' }),
    };
    const audit = { record: async () => undefined };

    service = new CustomerAuthService(
      { db } as never,
      passwords as never,
      customerTokens as never,
      tokens as never,
      rateLimit as unknown as RateLimitService,
      audit as never,
    );
  });

  async function attempt(): Promise<unknown> {
    return service.login(TENANT, customer!.email, 'guess', ctx);
  }

  it('locks the account after THRESHOLD consecutive wrong passwords', async () => {
    passwordOk = false;
    for (let i = 0; i < LOCKOUT_THRESHOLD; i++) {
      await expect(attempt()).resolves.toBeNull();
    }
    expect(customer!.failedAttempts).toBe(LOCKOUT_THRESHOLD);
    expect(customer!.lockedUntil).not.toBeNull();
    expect(customer!.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
  });

  it('a correct password is NOT blocked by an active lock and CLEARS it (anti-DoS)', async () => {
    // Attacker trips the lock with wrong passwords.
    passwordOk = false;
    for (let i = 0; i < LOCKOUT_THRESHOLD; i++) {
      await attempt();
    }
    expect(customer!.lockedUntil).not.toBeNull();

    // The legitimate owner logs in with the CORRECT password — must succeed despite the
    // lock, and the lock + counter must be cleared. This is the core anti-footgun: an
    // attacker must never be able to DoS a victim out of their own valid credential.
    passwordOk = true;
    const session = await service.login(TENANT, customer!.email, 'correct', ctx);
    expect(session).not.toBeNull();
    expect(customer!.failedAttempts).toBe(0);
    expect(customer!.lockedUntil).toBeNull();
  });

  it('resets failed_attempts on a successful login below the threshold', async () => {
    passwordOk = false;
    await attempt();
    await attempt();
    expect(customer!.failedAttempts).toBe(2);

    passwordOk = true;
    const session = await service.login(TENANT, customer!.email, 'correct', ctx);
    expect(session).not.toBeNull();
    expect(customer!.failedAttempts).toBe(0);
    expect(customer!.lockedUntil).toBeNull();
  });

  it('keeps counting wrong attempts while locked (lock stays within the window)', async () => {
    // A lock that is still in-window: a further wrong attempt bumps the counter but the
    // outcome stays a uniform null (no distinguishable "locked" response — no oracle).
    customer = makeCustomer({
      failedAttempts: LOCKOUT_THRESHOLD,
      lockedUntil: new Date(Date.now() + LOCKOUT_MS),
    });
    passwordOk = false;
    await expect(attempt()).resolves.toBeNull();
    expect(customer.lockedUntil).not.toBeNull();
    expect(customer.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
  });

  it('auto-unlocks after the window: an expired lock no longer blocks a correct password', async () => {
    // lockedUntil in the PAST = window elapsed. isLocked() returns false, so a correct
    // password authenticates normally (and resets the counter) without manual unlock.
    customer = makeCustomer({
      failedAttempts: LOCKOUT_THRESHOLD,
      lockedUntil: new Date(Date.now() - 1000),
    });
    passwordOk = true;
    const session = await service.login(TENANT, customer.email, 'correct', ctx);
    expect(session).not.toBeNull();
    expect(customer.failedAttempts).toBe(0);
    expect(customer.lockedUntil).toBeNull();
  });

  it('the lock is account-keyed: rotating the source IP does not reset the counter', async () => {
    // The admin-mirror counter lives on the customer ROW, not in an IP-keyed bucket, so
    // an attacker rotating IPs past the first throttle still trips the same lock.
    passwordOk = false;
    for (let i = 0; i < LOCKOUT_THRESHOLD; i++) {
      await service.login(TENANT, customer!.email, 'guess', {
        ip: `198.51.100.${i}`,
        userAgent: 'jest',
      });
    }
    expect(customer!.failedAttempts).toBe(LOCKOUT_THRESHOLD);
    expect(customer!.lockedUntil).not.toBeNull();
  });
});
