/**
 * SetupAdminService UNIT tests (`jest.config.js`).
 * THE MOST SECURITY-CRITICAL service: the email-OTP owner-credential flow.
 *
 * No real DB/Redis — lightweight fakes capture what would hit Postgres/Redis and a
 * controllable mail/SMTP sender records the OTP that was sent. The invariants pinned:
 *   - PRECONDITION: 422 when no mail transport (no persisted SMTP secret AND no env mail).
 *   - OTP STORED HASHED, NEVER PLAINTEXT: the Redis value holds SHA-256(otp), not the otp;
 *     the response is `{sent:true}` and never contains the OTP.
 *   - SEND PATH: with a persisted SMTP secret the OTP goes through the throwaway-transport
 *     sender (SetupConfigService.sendViaSmtpSecret), reused — not the env MailService.
 *   - VERIFY happy path: a correct OTP sets the owner password (Argon2id hash applied to
 *     the owner row), marks admin_configured, and DELETES the OTP (single-use).
 *   - REPLAY: a second verify with the same OTP → 401 (the key was deleted).
 *   - WRONG/EXPIRED OTP → 401 (uniform, no oracle).
 *   - BREACHED password → 422 ONLY past a valid OTP (so it never consumes the OTP — it
 *     can be retried with a stronger password) and NEVER without a valid OTP (no
 *     weak-password 422 vs wrong-OTP 401 oracle).
 *   - RATE LIMIT: verify is throttled per-IP AND per-email (a 429 from either gate is
 *     raised before any OTP work and never reveals password weakness).
 */
import { createHash } from 'node:crypto';
import { HttpException, UnauthorizedException, UnprocessableEntityException } from '@nestjs/common';
import { SetupAdminService } from './setup-admin.service';
import type { AdminAccountStartDto, AdminAccountVerifyDto } from './dto/admin-account.dto';

const TENANT = '00000000-0000-7000-8000-0000000000aa';
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** Minimal in-memory Redis (get/set/del) — the only commands the service uses. */
class FakeRedis {
  store = new Map<string, string>();
  client = {
    get: (k: string): Promise<string | null> => Promise.resolve(this.store.get(k) ?? null),
    set: (k: string, v: string): Promise<'OK'> => {
      this.store.set(k, v);
      return Promise.resolve('OK');
    },
    del: (k: string): Promise<number> => {
      const had = this.store.delete(k);
      return Promise.resolve(had ? 1 : 0);
    },
  };
}

/** Captures the row update + admin_configured upsert that would hit Postgres. */
class FakeDatabase {
  ownerRow = {
    id: 'owner-1',
    passwordHash: 'PLACEHOLDER',
    email: 'admin@default.local',
    name: 'Administrator',
    tokenVersion: 0,
  };
  ownerCount = 1;
  adminConfigured = false;
  lastUpdate: Record<string, unknown> | null = null;

  db = {
    transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(this.tx),
  };

  private tx = {
    update: () => ({
      set: (vals: Record<string, unknown>) => ({
        where: () => ({
          returning: (): Promise<{ id: string }[]> => {
            if (this.ownerCount !== 1) return Promise.resolve([]);
            this.lastUpdate = vals;
            this.ownerRow.passwordHash = String(vals.passwordHash);
            this.ownerRow.email = String(vals.email);
            this.ownerRow.name = String(vals.name);
            return Promise.resolve([{ id: this.ownerRow.id }]);
          },
        }),
      }),
    }),
    insert: () => ({
      values: () => ({
        onConflictDoUpdate: (): Promise<void> => {
          this.adminConfigured = true;
          return Promise.resolve();
        },
      }),
    }),
  };
}

const passwords = {
  hash: (pw: string): Promise<string> => Promise.resolve(`$argon2id$HASHED(${pw})`),
};

/**
 * Inspectable rate-limit fake: records every key it was asked to check, and can be told
 * to BLOCK a specific key (substring match) so a test can assert the per-IP / per-email
 * gates exist and trip a 429.
 */
class FakeRateLimit {
  keys: string[] = [];
  blockSubstring: string | null = null;
  check = (key: string): Promise<{ allowed: boolean; count: number; degraded: boolean }> => {
    this.keys.push(key);
    const allowed = this.blockSubstring === null || !key.includes(this.blockSubstring);
    return Promise.resolve({ allowed, count: 1, degraded: false });
  };
}

/** Capturing sender: records the OTP message; default ok. */
class FakeConfig {
  sent: { to: string; subject: string; text: string }[] = [];
  result: { ok: boolean; error?: string } = { ok: true };
  sendViaSmtpSecret = (
    _creds: unknown,
    msg: { to: string; subject: string; text: string },
  ): Promise<{ ok: boolean; error?: string }> => {
    this.sent.push(msg);
    return Promise.resolve(this.result);
  };
}

class FakeMail {
  calls: { to: string }[] = [];
  send = (opts: { to: string }): Promise<Record<string, never>> => {
    this.calls.push({ to: opts.to });
    return Promise.resolve({});
  };
}

interface Fixture {
  svc: SetupAdminService;
  redis: FakeRedis;
  db: FakeDatabase;
  config: FakeConfig;
  mail: FakeMail;
  rateLimit: FakeRateLimit;
  secrets: { has: boolean; creds: unknown };
}

function build(opts: { smtpSecret?: unknown; envMail?: boolean } = {}): Fixture {
  const redis = new FakeRedis();
  const db = new FakeDatabase();
  const config = new FakeConfig();
  const mail = new FakeMail();
  const rateLimit = new FakeRateLimit();
  const secretsState = { has: opts.smtpSecret !== undefined, creds: opts.smtpSecret ?? null };
  const secrets = {
    getJson: (): Promise<unknown> => Promise.resolve(secretsState.creds),
  };
  // env mail gate reads process.env directly — toggle SMTP_HOST.
  if (opts.envMail) process.env.SMTP_HOST = 'mail.test';
  else delete process.env.SMTP_HOST;
  delete process.env.BREVO_API_KEY;

  const svc = new SetupAdminService(
    db as never,
    redis as never,
    rateLimit as never,
    passwords as never,
    secrets as never,
    config as never,
    mail as never,
  );
  return { svc, redis, db, config, mail, rateLimit, secrets: secretsState };
}

const startDto = (over: Partial<AdminAccountStartDto> = {}): AdminAccountStartDto =>
  ({ email: 'Owner@Example.com', name: 'The Owner', ...over }) as AdminAccountStartDto;
const verifyDto = (otp: string, over: Partial<AdminAccountVerifyDto> = {}): AdminAccountVerifyDto =>
  ({
    email: 'Owner@Example.com',
    otp,
    password: 'correct horse battery staple',
    ...over,
  }) as AdminAccountVerifyDto;

/** The single Redis OTP key (email is lower-cased + sha256'd inside the service). */
const otpKey = (): string => `setup:admin-otp:${sha256('owner@example.com')}`;

describe('SetupAdminService (unit, SECURITY-CRITICAL)', () => {
  afterAll(() => {
    delete process.env.SMTP_HOST;
    delete process.env.BREVO_API_KEY;
  });

  describe('start — precondition + OTP issue', () => {
    it('422 when NO mail transport is configured (no SMTP secret, no env mail)', async () => {
      const { svc } = build({ envMail: false });
      await expect(svc.start(TENANT, startDto(), { ip: '1.2.3.4' })).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
    });

    it('with a persisted SMTP secret → stores hash(otp) (NOT plaintext) + sends via throwaway transport', async () => {
      const creds = { host: 'h', port: 587, secure: false, from: 'f@x.test' };
      const { svc, redis, config } = build({ smtpSecret: creds });

      const res = await svc.start(TENANT, startDto(), { ip: '1.2.3.4' });
      expect(res).toEqual({ sent: true });
      // Sent via the persisted-SMTP path, not env mail.
      expect(config.sent).toHaveLength(1);

      // The OTP body carries a 6-digit code; the STORED value is its hash, not the code.
      const otpMatch = /(\d{6})/.exec(config.sent[0]!.text);
      expect(otpMatch).not.toBeNull();
      const otp = otpMatch![1]!;
      const stored = redis.store.get(otpKey());
      expect(stored).toBeDefined();
      const payload = JSON.parse(stored!) as { otpHash: string; name: string };
      expect(payload.otpHash).toBe(sha256(otp));
      // The plaintext OTP is NOT in the stored record.
      expect(stored).not.toContain(otp);
      // The response never contains the OTP.
      expect(JSON.stringify(res)).not.toContain(otp);
    });

    it('falls back to env MailService when only env mail is configured (no SMTP secret)', async () => {
      const { svc, mail, config } = build({ envMail: true });
      await svc.start(TENANT, startDto(), { ip: '1.2.3.4' });
      expect(mail.calls).toHaveLength(1);
      expect(config.sent).toHaveLength(0);
    });

    it('drops the staged OTP + throws 502 when the configured transport send fails', async () => {
      const creds = { host: 'h', port: 587, secure: false, from: 'f@x.test' };
      const { svc, redis, config } = build({ smtpSecret: creds });
      config.result = { ok: false, error: 'SMTP error 421' };
      await expect(svc.start(TENANT, startDto(), { ip: '1.2.3.4' })).rejects.toBeInstanceOf(
        HttpException,
      );
      expect(redis.store.get(otpKey())).toBeUndefined();
    });
  });

  describe('verify — set owner credential', () => {
    /** Run start (SMTP secret) and return the issued OTP. */
    async function startAndGetOtp(f: Fixture): Promise<string> {
      await f.svc.start(TENANT, startDto(), { ip: '1.2.3.4' });
      const otp = /(\d{6})/.exec(f.config.sent.at(-1)!.text)![1]!;
      return otp;
    }

    it('correct OTP sets the Argon2id owner password + marks admin_configured + deletes the OTP', async () => {
      const f = build({ smtpSecret: { host: 'h', port: 587, secure: false, from: 'f@x.test' } });
      const otp = await startAndGetOtp(f);

      const res = await f.svc.verify(TENANT, verifyDto(otp), { ip: '1.2.3.4' });
      expect(res).toEqual({ ok: true });
      // Owner row got the Argon2id hash, lower-cased email, and the start-time name.
      expect(f.db.ownerRow.passwordHash).toContain('$argon2id$');
      expect(f.db.ownerRow.email).toBe('owner@example.com');
      expect(f.db.ownerRow.name).toBe('The Owner');
      expect(f.db.adminConfigured).toBe(true);
      // token_version bumped (sql expression captured) — the update ran.
      expect(f.db.lastUpdate).not.toBeNull();
      // Single-use: the OTP key is gone.
      expect(f.redis.store.get(otpKey())).toBeUndefined();
    });

    it('REPLAY of a consumed OTP → 401 (single-use)', async () => {
      const f = build({ smtpSecret: { host: 'h', port: 587, secure: false, from: 'f@x.test' } });
      const otp = await startAndGetOtp(f);
      await f.svc.verify(TENANT, verifyDto(otp), { ip: '1.2.3.4' });
      await expect(f.svc.verify(TENANT, verifyDto(otp), { ip: '1.2.3.4' })).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('WRONG OTP → 401 (uniform, no oracle) and does NOT burn the real OTP', async () => {
      const f = build({ smtpSecret: { host: 'h', port: 587, secure: false, from: 'f@x.test' } });
      const realOtp = await startAndGetOtp(f);
      const wrong = realOtp === '000000' ? '111111' : '000000';
      await expect(
        f.svc.verify(TENANT, verifyDto(wrong), { ip: '1.2.3.4' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      // The real OTP still works afterwards (a wrong guess must not consume it).
      await expect(f.svc.verify(TENANT, verifyDto(realOtp), { ip: '1.2.3.4' })).resolves.toEqual({
        ok: true,
      });
    });

    it('NO OTP issued (expired/absent) → 401', async () => {
      const f = build({ smtpSecret: { host: 'h', port: 587, secure: false, from: 'f@x.test' } });
      await expect(
        f.svc.verify(TENANT, verifyDto('123456'), { ip: '1.2.3.4' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('VALID OTP + BREACHED password → 422 but does NOT consume the OTP (retryable with a stronger one)', async () => {
      const f = build({ smtpSecret: { host: 'h', port: 587, secure: false, from: 'f@x.test' } });
      const otp = await startAndGetOtp(f);
      await expect(
        f.svc.verify(TENANT, verifyDto(otp, { password: 'password1234' }), { ip: '1.2.3.4' }),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      // The OTP was NOT consumed (the breach-check fails BEFORE the single-use DEL).
      expect(f.redis.store.get(otpKey())).toBeDefined();
      // Retrying the SAME OTP with a strong password now succeeds + burns the OTP once.
      await expect(f.svc.verify(TENANT, verifyDto(otp), { ip: '1.2.3.4' })).resolves.toEqual({
        ok: true,
      });
      expect(f.redis.store.get(otpKey())).toBeUndefined();
    });

    it('NO ORACLE — a WRONG OTP with a WEAK password → 401 (same as wrong-OTP), NOT 422', async () => {
      const f = build({ smtpSecret: { host: 'h', port: 587, secure: false, from: 'f@x.test' } });
      const realOtp = await startAndGetOtp(f);
      const wrong = realOtp === '000000' ? '111111' : '000000';
      // Without a valid OTP the breach-check is unreachable: a weak password yields the
      // SAME 401 as a wrong OTP, so the password's strength is never disclosed.
      await expect(
        f.svc.verify(TENANT, verifyDto(wrong, { password: 'password1234' }), { ip: '1.2.3.4' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      // The real OTP was not burned by the probe.
      expect(f.redis.store.get(otpKey())).toBeDefined();
    });

    it('throttles per-IP AND per-email (both gates are checked before any OTP work)', async () => {
      const f = build({ smtpSecret: { host: 'h', port: 587, secure: false, from: 'f@x.test' } });
      const otp = await startAndGetOtp(f);
      f.rateLimit.keys = [];
      await f.svc.verify(TENANT, verifyDto(otp), { ip: '1.2.3.4' });
      expect(f.rateLimit.keys).toEqual(
        expect.arrayContaining([
          expect.stringContaining('setup:admin-verify:ip:'),
          expect.stringContaining('setup:admin-verify:email:'),
        ]),
      );
    });

    it('PER-EMAIL throttle trips a 429 even when the per-IP gate is open, without consuming the OTP', async () => {
      const f = build({ smtpSecret: { host: 'h', port: 587, secure: false, from: 'f@x.test' } });
      const otp = await startAndGetOtp(f);
      // Block ONLY the per-email gate; the per-IP gate stays open.
      f.rateLimit.blockSubstring = 'setup:admin-verify:email:';
      await expect(f.svc.verify(TENANT, verifyDto(otp), { ip: '1.2.3.4' })).rejects.toMatchObject({
        // HttpException(TOO_MANY_REQUESTS) — 429.
        status: 429,
      });
      // The OTP is untouched (throttled before the lookup/burn).
      expect(f.redis.store.get(otpKey())).toBeDefined();
    });
  });
});
