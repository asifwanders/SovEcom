/**
 * Setup admin-account + /complete integration (SECURITY-CRITICAL).
 * Real Postgres + Redis. Boots the full AppModule with the
 * MAIL_SERVICE overridden by a CAPTURING mock (so the OTP is asserted via the mock, never
 * a real SMTP server), seeds ONE tenant + the seeded OWNER SHELL + `default_tenant_id`,
 * and drives the email-OTP owner-credential flow + install completion behind
 * {@link SetupTokenGuard}.
 *
 * Covers:
 *   - GUARD GATING: every route 404 without a live token + 404 post-install;
 *   - admin/start: 422 when no mail transport; with env mail → OTP stored HASHED (never
 *     plaintext) + sent (asserted via the mock); never returns the OTP;
 *   - admin/verify: correct OTP SETS the owner password (hash changes off the placeholder,
 *     login would verify) + marks admin_configured + SINGLE-USE (replay → 401);
 *   - wrong/expired OTP → 401 (no oracle); breached password → 422;
 *   - complete: 422 until admin + tax done; consumes the token + flips installed;
 *   - after complete, a guarded route 404s (surface closed); /status still reachable.
 */
import 'reflect-metadata';
import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ZodValidationPipe } from 'nestjs-zod';
import cookieParser from 'cookie-parser';
import { createHash } from 'node:crypto';
import postgres from 'postgres';
import { drizzle, PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import Redis from 'ioredis';
import { uuidv7 } from 'uuidv7';
import * as schema from '../../../src/database/schema';
import { AppModule } from '../../../src/app.module';
import { AllExceptionsFilter } from '../../../src/common/filters/all-exceptions.filter';
import { SetupTokenService } from '../../../src/setup/setup-token.service';
import { MAIL_SERVICE } from '../../../src/mail/mail.service';
import {
  VIES_CLIENT,
  type ViesClient,
  type ViesCheckResult,
} from '../../../src/customers/vies/vies.client';

const MIGRATIONS = 'src/database/migrations';
const PLACEHOLDER_HASH = '$argon2id$v=19$m=65536,t=3,p=4$c2VlZHNhbHQ$bm90LWEtcmVhbC1oYXNo';

const ROUTES = {
  start: '/setup/v1/admin-account/start',
  verify: '/setup/v1/admin-account/verify',
  complete: '/setup/v1/complete',
  tax: '/setup/v1/tax/configure',
  status: '/setup/v1/status',
} as const;

/** Capturing mail mock — records every send so the test can read the OTP body. */
class CapturingMail {
  sends: { to: string; subject: string; text: string }[] = [];
  send(opts: { to: string; subject: string; text: string }): Promise<Record<string, never>> {
    this.sends.push(opts);
    return Promise.resolve({});
  }
  sendPasswordReset(): Promise<void> {
    return Promise.resolve();
  }
  reset(): void {
    this.sends = [];
  }
  lastOtp(): string | null {
    const text = this.sends.at(-1)?.text ?? '';
    return /(\d{6})/.exec(text)?.[1] ?? null;
  }
}

/** VIES stub — no network egress; VAT always unreachable (fail-open). */
class StubVies implements ViesClient {
  check(): Promise<ViesCheckResult> {
    return Promise.resolve({ status: 'unreachable' });
  }
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const otpRedisKey = (emailLower: string): string => `setup:admin-otp:${sha256(emailLower)}`;

describe('Setup admin-account + complete (integration, SECURITY-CRITICAL)', () => {
  let app: INestApplication;
  let client: ReturnType<typeof postgres>;
  let db: PostgresJsDatabase<typeof schema>;
  let redis: Redis;
  let tokens: SetupTokenService;
  let mail: CapturingMail;
  let tenantId: string;
  const savedSmtpHost = process.env.SMTP_HOST;
  const savedBrevo = process.env.BREVO_API_KEY;

  beforeAll(async () => {
    process.env.JWT_SECRET ??= 'integration-jwt-secret-integration-jwt-secret-32+';
    process.env.MASTER_KEY ??= Buffer.alloc(32, 0x2a).toString('base64');
    process.env.NODE_ENV = 'test';

    const url = process.env.DATABASE_URL as string;
    client = postgres(url, { max: 4, onnotice: () => {} });
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS });
    redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
    mail = new CapturingMail();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MAIL_SERVICE)
      .useValue(mail)
      .overrideProvider(VIES_CLIENT)
      .useValue(new StubVies())
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    app.set('trust proxy', 1);
    app.use(cookieParser());
    app.useGlobalPipes(new ZodValidationPipe());
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    tokens = app.get(SetupTokenService, { strict: false });
  });

  afterAll(async () => {
    await app?.close();
    await client?.end({ timeout: 5 });
    await redis?.quit();
    if (savedSmtpHost === undefined) delete process.env.SMTP_HOST;
    else process.env.SMTP_HOST = savedSmtpHost;
    if (savedBrevo === undefined) delete process.env.BREVO_API_KEY;
    else process.env.BREVO_API_KEY = savedBrevo;
  });

  beforeEach(async () => {
    await client.unsafe(`TRUNCATE TABLE setup_tokens RESTART IDENTITY`);
    await client.unsafe(`TRUNCATE TABLE tenants CASCADE`);
    await client.unsafe(
      `DELETE FROM system_state WHERE key IN ('installed','default_tenant_id','admin_configured','db_config')`,
    );
    await redis.flushdb();
    mail.reset();
    // Default: env mail "configured" so admin/start's precondition passes; the actual
    // send is captured by the MAIL_SERVICE mock (no real SMTP server).
    process.env.SMTP_HOST = 'mail.test.invalid';
    delete process.env.BREVO_API_KEY;

    tenantId = uuidv7();
    await client`insert into tenants (id, name, slug) values (${tenantId}, 'T', ${'t-' + tenantId})`;
    // The seeded OWNER SHELL — placeholder hash, role owner. admin/verify UPDATES this row.
    await client`
      insert into users (id, tenant_id, email, password_hash, name, role)
      values (${uuidv7()}, ${tenantId}, ${'admin@default.local'}, ${PLACEHOLDER_HASH}, ${'Administrator'}, ${'owner'})
    `;
    await client`insert into system_state (key, value) values ('default_tenant_id', to_jsonb(${tenantId}::text))`;
    await setInstalled(false);
    // SetupStateService + TenantSettingsService cache per-tenant state across tests; clear.
    const state = app.get(
      (await import('../../../src/setup/setup-state.service')).SetupStateService,
      { strict: false },
    );
    (state as unknown as { defaultTenantId: string | null }).defaultTenantId = null;
    const settings = app.get(
      (await import('../../../src/taxes/tenant-settings.service')).TenantSettingsService,
      { strict: false },
    );
    settings.invalidate(tenantId);
  });

  const setInstalled = async (value: boolean): Promise<void> => {
    await client`
      insert into system_state (key, value)
      values ('installed', to_jsonb(${value}::boolean))
      on conflict (key) do update set value = excluded.value, updated_at = now()
    `;
  };

  const liveToken = (): Promise<string> => tokens.generateToken();
  const OWNER = { email: 'Owner@Example.com', name: 'The Owner' };
  const STRONG_PW = 'correct horse battery staple';

  /** Drive start, returning the OTP captured by the mail mock. */
  async function startAndCaptureOtp(token: string): Promise<string> {
    await request(app.getHttpServer())
      .post(ROUTES.start)
      .set('X-Setup-Token', token)
      .send(OWNER)
      .expect(200, { sent: true });
    const otp = mail.lastOtp();
    if (!otp) throw new Error('no OTP captured from the mail mock');
    return otp;
  }

  /** Persist a valid tax/onboarding profile so /complete's tax precondition passes. */
  async function configureTax(token: string): Promise<void> {
    await request(app.getHttpServer())
      .post(ROUTES.tax)
      .set('X-Setup-Token', token)
      // Non-EU country so tax_mode='none' is valid (the EU guardrail forbids 'none' for
      // an EU origin — that path is covered by the onboarding suite).
      .send({ businessCountry: 'US', defaultCurrency: 'USD', taxMode: 'none' })
      .expect(200);
  }

  // ─── Guard gating ──────────────────────────────────────────────────────────────

  it('admin/start + verify + complete all 404 WITHOUT a token (uniform hiding)', async () => {
    for (const path of [ROUTES.start, ROUTES.verify, ROUTES.complete]) {
      await request(app.getHttpServer()).post(path).send({}).expect(404);
    }
  });

  it('admin/start + complete 404 POST-INSTALL even with a valid token (lockdown)', async () => {
    const token = await liveToken();
    await setInstalled(true);
    for (const path of [ROUTES.start, ROUTES.complete]) {
      await request(app.getHttpServer())
        .post(path)
        .set('X-Setup-Token', token)
        .send(OWNER)
        .expect(404);
    }
  });

  // ─── admin/start ─────────────────────────────────────────────────────────────────

  it('start → 422 when NO mail transport is configured (no SMTP secret, no env mail)', async () => {
    const token = await liveToken();
    delete process.env.SMTP_HOST;
    delete process.env.BREVO_API_KEY;
    await request(app.getHttpServer())
      .post(ROUTES.start)
      .set('X-Setup-Token', token)
      .send(OWNER)
      .expect(422);
  });

  it('start → stores hash(otp) (NEVER plaintext) in Redis + sends via the mock; never returns the OTP', async () => {
    const token = await liveToken();
    const res = await request(app.getHttpServer())
      .post(ROUTES.start)
      .set('X-Setup-Token', token)
      .send(OWNER)
      .expect(200);
    expect(res.body).toEqual({ sent: true });

    const otp = mail.lastOtp();
    expect(otp).toMatch(/^\d{6}$/);
    // The response NEVER contains the OTP.
    expect(JSON.stringify(res.body)).not.toContain(otp);

    // Redis holds the HASH, not the plaintext OTP.
    const stored = await redis.get(otpRedisKey('owner@example.com'));
    expect(stored).not.toBeNull();
    const payload = JSON.parse(stored as string) as { otpHash: string; name: string };
    expect(payload.otpHash).toBe(sha256(otp as string));
    expect(stored).not.toContain(otp as string);
  });

  // ─── admin/verify ────────────────────────────────────────────────────────────────

  it('verify with the correct OTP SETS the owner password (off the placeholder) + marks admin_configured', async () => {
    const token = await liveToken();
    const otp = await startAndCaptureOtp(token);

    await request(app.getHttpServer())
      .post(ROUTES.verify)
      .set('X-Setup-Token', token)
      .send({ email: OWNER.email, otp, password: STRONG_PW })
      .expect(200, { ok: true });

    // Owner row updated: hash != placeholder, email lower-cased, name set, tv bumped.
    const rows = await client<
      { password_hash: string; email: string; name: string; role: string; token_version: number }[]
    >`select password_hash, email, name, role, token_version from users where tenant_id = ${tenantId} and role = 'owner'`;
    expect(rows).toHaveLength(1);
    expect(rows[0].password_hash).not.toBe(PLACEHOLDER_HASH);
    expect(rows[0].password_hash.startsWith('$argon2id$')).toBe(true);
    expect(rows[0].email).toBe('owner@example.com');
    expect(rows[0].name).toBe('The Owner');
    expect(rows[0].token_version).toBe(1);

    // admin_configured marker set.
    const mark = await client<{ value: boolean }[]>`
      select value from system_state where key = 'admin_configured'`;
    expect(mark[0]?.value).toBe(true);

    // SINGLE-USE: the OTP key is gone.
    expect(await redis.get(otpRedisKey('owner@example.com'))).toBeNull();
  });

  it('verify is SINGLE-USE — a replay of the same OTP → 401', async () => {
    const token = await liveToken();
    const otp = await startAndCaptureOtp(token);
    await request(app.getHttpServer())
      .post(ROUTES.verify)
      .set('X-Setup-Token', token)
      .send({ email: OWNER.email, otp, password: STRONG_PW })
      .expect(200);
    await request(app.getHttpServer())
      .post(ROUTES.verify)
      .set('X-Setup-Token', token)
      .send({ email: OWNER.email, otp, password: STRONG_PW })
      .expect(401);
  });

  it('verify with a WRONG OTP → 401 (no oracle) and does not burn the real OTP', async () => {
    const token = await liveToken();
    const otp = await startAndCaptureOtp(token);
    const wrong = otp === '000000' ? '111111' : '000000';
    await request(app.getHttpServer())
      .post(ROUTES.verify)
      .set('X-Setup-Token', token)
      .send({ email: OWNER.email, otp: wrong, password: STRONG_PW })
      .expect(401);
    // The real OTP still works.
    await request(app.getHttpServer())
      .post(ROUTES.verify)
      .set('X-Setup-Token', token)
      .send({ email: OWNER.email, otp, password: STRONG_PW })
      .expect(200);
  });

  it('verify with NO OTP issued (expired/absent) → 401', async () => {
    const token = await liveToken();
    await request(app.getHttpServer())
      .post(ROUTES.verify)
      .set('X-Setup-Token', token)
      .send({ email: OWNER.email, otp: '123456', password: STRONG_PW })
      .expect(401);
  });

  it('verify with a BREACHED password → 422', async () => {
    const token = await liveToken();
    const otp = await startAndCaptureOtp(token);
    await request(app.getHttpServer())
      .post(ROUTES.verify)
      .set('X-Setup-Token', token)
      .send({ email: OWNER.email, otp, password: 'password1234' })
      .expect(422);
  });

  it('NO weak-password ORACLE — a WRONG OTP returns the SAME 401 whether the password is weak or strong', async () => {
    const token = await liveToken();
    const otp = await startAndCaptureOtp(token);
    const wrong = otp === '000000' ? '111111' : '000000';

    // Wrong OTP + WEAK (breached) password → MUST be 401, NOT 422. Without a valid OTP
    // the caller cannot reach (and therefore cannot probe) the breach-check.
    await request(app.getHttpServer())
      .post(ROUTES.verify)
      .set('X-Setup-Token', token)
      .send({ email: OWNER.email, otp: wrong, password: 'password1234' })
      .expect(401);

    // Wrong OTP + STRONG password → the SAME uniform 401 (identical status: no oracle).
    await request(app.getHttpServer())
      .post(ROUTES.verify)
      .set('X-Setup-Token', token)
      .send({ email: OWNER.email, otp: wrong, password: STRONG_PW })
      .expect(401);

    // The real OTP was never burned by either probe — it still works.
    await request(app.getHttpServer())
      .post(ROUTES.verify)
      .set('X-Setup-Token', token)
      .send({ email: OWNER.email, otp, password: STRONG_PW })
      .expect(200);
  });

  it('valid OTP + WEAK password → 422 does NOT consume the OTP; a retry with the SAME OTP + strong password succeeds', async () => {
    const token = await liveToken();
    const otp = await startAndCaptureOtp(token);

    // Valid OTP but weak password → 422. The OTP must NOT be consumed.
    await request(app.getHttpServer())
      .post(ROUTES.verify)
      .set('X-Setup-Token', token)
      .send({ email: OWNER.email, otp, password: 'password1234' })
      .expect(422);

    // The OTP is still live in Redis (not burned by the breach-check failure).
    expect(await redis.get(otpRedisKey('owner@example.com'))).not.toBeNull();

    // Retrying the SAME OTP with a strong password now succeeds.
    await request(app.getHttpServer())
      .post(ROUTES.verify)
      .set('X-Setup-Token', token)
      .send({ email: OWNER.email, otp, password: STRONG_PW })
      .expect(200, { ok: true });

    // ...and is consumed exactly once (single-use intact).
    expect(await redis.get(otpRedisKey('owner@example.com'))).toBeNull();
  });

  it('PER-EMAIL verify throttle → 429 after the cap, even across DIFFERENT IPs (distributed brute force)', async () => {
    const token = await liveToken();
    await startAndCaptureOtp(token);
    // The per-email limit is 10/hour. Exhaust it from DISTINCT source IPs (the per-IP
    // gate is 10/min, so rotating IPs would otherwise dodge it). All wrong OTPs → 401,
    // until the per-email gate trips → 429.
    const wrong = '000000';
    for (let i = 0; i < 10; i++) {
      await request(app.getHttpServer())
        .post(ROUTES.verify)
        .set('X-Setup-Token', token)
        .set('X-Forwarded-For', `203.0.113.${i + 1}`)
        .send({ email: OWNER.email, otp: wrong, password: STRONG_PW })
        .expect(401);
    }
    // 11th attempt from yet another IP — over the per-email budget → 429.
    await request(app.getHttpServer())
      .post(ROUTES.verify)
      .set('X-Setup-Token', token)
      .set('X-Forwarded-For', '203.0.113.250')
      .send({ email: OWNER.email, otp: wrong, password: STRONG_PW })
      .expect(429);
  });

  it('CONCURRENCY — two simultaneous verifies with the SAME valid OTP → exactly one wins (single-use atomicity)', async () => {
    const token = await liveToken();
    const otp = await startAndCaptureOtp(token);

    const fire = (): request.Test =>
      request(app.getHttpServer())
        .post(ROUTES.verify)
        .set('X-Setup-Token', token)
        .send({ email: OWNER.email, otp, password: STRONG_PW });

    const results = await Promise.all([fire(), fire()]);
    const statuses = results.map((r) => r.status).sort();
    // Exactly one 200 and one 401 — the DEL-returns-1 gate admits a single winner.
    expect(statuses).toEqual([200, 401]);

    // The OTP is consumed; the owner row was updated exactly once.
    expect(await redis.get(otpRedisKey('owner@example.com'))).toBeNull();
    const rows = await client<{ token_version: number }[]>`
      select token_version from users where tenant_id = ${tenantId} and role = 'owner'`;
    expect(rows).toHaveLength(1);
    expect(rows[0].token_version).toBe(1);
  });

  // ─── complete ────────────────────────────────────────────────────────────────────

  it('complete → 422 when admin AND tax are unconfigured (lists missing)', async () => {
    const token = await liveToken();
    const res = await request(app.getHttpServer())
      .post(ROUTES.complete)
      .set('X-Setup-Token', token)
      .send({})
      .expect(422);
    expect(res.body.missing).toEqual(
      expect.arrayContaining(['admin_account', 'tax_configuration']),
    );
    // The token was NOT consumed (preconditions failed before the claim).
    const live = await client<{ c: number }[]>`
      select count(*)::int as c from setup_tokens where used_at is null and expires_at > now()`;
    expect(Number(live[0].c)).toBe(1);
  });

  it('complete → 422 when admin is done but tax is NOT', async () => {
    const token = await liveToken();
    const otp = await startAndCaptureOtp(token);
    await request(app.getHttpServer())
      .post(ROUTES.verify)
      .set('X-Setup-Token', token)
      .send({ email: OWNER.email, otp, password: STRONG_PW })
      .expect(200);
    const res = await request(app.getHttpServer())
      .post(ROUTES.complete)
      .set('X-Setup-Token', token)
      .send({})
      .expect(422);
    expect(res.body.missing).toEqual(['tax_configuration']);
  });

  it('complete (admin + tax done) consumes the token + flips installed; surface then 404s', async () => {
    const token = await liveToken();
    const otp = await startAndCaptureOtp(token);
    await request(app.getHttpServer())
      .post(ROUTES.verify)
      .set('X-Setup-Token', token)
      .send({ email: OWNER.email, otp, password: STRONG_PW })
      .expect(200);
    await configureTax(token);

    await request(app.getHttpServer())
      .post(ROUTES.complete)
      .set('X-Setup-Token', token)
      .expect(200, { installed: true });

    // installed flipped + token consumed.
    const installed = await client<{ value: boolean }[]>`
      select value from system_state where key = 'installed'`;
    expect(installed[0].value).toBe(true);
    const used = await client<{ c: number }[]>`
      select count(*)::int as c from setup_tokens where used_at is not null`;
    expect(Number(used[0].c)).toBe(1);

    // The whole setup surface is now closed (guard 404s), EXCEPT GET /status.
    await request(app.getHttpServer())
      .post(ROUTES.complete)
      .set('X-Setup-Token', token)
      .expect(404);
    await request(app.getHttpServer()).get(ROUTES.status).expect(200);
  });
});
