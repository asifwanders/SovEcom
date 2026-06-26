/**
 * Setup config endpoints integration (SECURITY-CRITICAL).
 * Real Postgres + Redis. Boots the full AppModule, seeds ONE tenant + `default_tenant_id`
 * (the migrator does not run the seed), and drives the database/smtp/payments steps
 * behind {@link SetupTokenGuard}.
 *
 * Covers:
 *   - GUARD GATING: every step route is 404 without a live token, 404 post-install,
 *     200 with a valid `X-Setup-Token` (the @Public + SetupTokenGuard combination);
 *   - database/test: ok against the real DB url; clean {ok:false,error} for a bad url
 *     with NO credential leak (the password never appears in the error/body);
 *   - smtp/test: a throwaway-transport failure to an unreachable host returns a
 *     sanitized clean error (the live MailService singleton is untouched);
 *   - smtp/configure + payments/configure persist CIPHERTEXT — the `tenant_secrets`
 *     row's ciphertext != plaintext AND decrypts (round-trip) to the submitted creds;
 *   - the secret is AAD-bound to the tenant (a wrong-tenant decrypt fails closed);
 *   - payments/configure persists `methods` into `tenants.settings.payments` and never
 *     stores/echoes the Stripe key;
 *   - NO SECRET LEAK: no submitted key/password appears in any response body.
 */
import 'reflect-metadata';
import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ZodValidationPipe } from 'nestjs-zod';
import cookieParser from 'cookie-parser';
import postgres from 'postgres';
import { drizzle, PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import Redis from 'ioredis';
import { uuidv7 } from 'uuidv7';
import * as schema from '../../../src/database/schema';
import { AppModule } from '../../../src/app.module';
import { AllExceptionsFilter } from '../../../src/common/filters/all-exceptions.filter';
import { AeadService } from '../../../src/auth/crypto/aead.service';
import { SetupTokenService } from '../../../src/setup/setup-token.service';

const MIGRATIONS = 'src/database/migrations';
const ROUTES = {
  dbTest: '/setup/v1/database/test',
  dbConfigure: '/setup/v1/database/configure',
  smtpTest: '/setup/v1/smtp/test',
  smtpConfigure: '/setup/v1/smtp/configure',
  paymentsConfigure: '/setup/v1/payments/configure',
} as const;

describe('Setup config endpoints (integration, SECURITY-CRITICAL)', () => {
  let app: INestApplication;
  let client: ReturnType<typeof postgres>;
  let db: PostgresJsDatabase<typeof schema>;
  let redis: Redis;
  let tokens: SetupTokenService;
  let aead: AeadService;
  let tenantId: string;

  beforeAll(async () => {
    process.env.JWT_SECRET ??= 'integration-jwt-secret-integration-jwt-secret-32+';
    process.env.MASTER_KEY ??= Buffer.alloc(32, 0x2a).toString('base64');
    process.env.NODE_ENV = 'test';

    const url = process.env.DATABASE_URL as string;
    // Silence TRUNCATE ... CASCADE NOTICE chatter so the suite output stays clean.
    client = postgres(url, { max: 4, onnotice: () => {} });
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS });
    redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    app.set('trust proxy', 1);
    app.use(cookieParser());
    app.useGlobalPipes(new ZodValidationPipe());
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    tokens = app.get(SetupTokenService, { strict: false });
    aead = app.get(AeadService, { strict: false });
  });

  afterAll(async () => {
    await app?.close();
    await client?.end({ timeout: 5 });
    await redis?.quit();
  });

  /** Fresh setup state + a seeded tenant + default_tenant_id before each test. */
  beforeEach(async () => {
    await client.unsafe(`TRUNCATE TABLE setup_tokens RESTART IDENTITY`);
    // CASCADE: tenant_secrets + any leftover child rows from other serial suites so the
    // fresh single-tenant fixture is clean (FK to tenants would otherwise block delete).
    await client.unsafe(`TRUNCATE TABLE tenants CASCADE`);
    await client.unsafe(
      `DELETE FROM system_state WHERE key IN ('installed','default_tenant_id','db_config')`,
    );
    await redis.flushdb();

    tenantId = uuidv7();
    await client`insert into tenants (id, name, slug) values (${tenantId}, 'T', ${'t-' + tenantId})`;
    await client`insert into system_state (key, value) values ('default_tenant_id', to_jsonb(${tenantId}::text))`;
    await setInstalled(false);
    // The SetupStateService caches default_tenant_id; clear it so each test's fresh
    // tenant id is read (the cache survives across tests in one app instance).
    const state = app.get(
      (await import('../../../src/setup/setup-state.service')).SetupStateService,
      { strict: false },
    );
    (state as unknown as { defaultTenantId: string | null }).defaultTenantId = null;
  });

  const setInstalled = async (value: boolean): Promise<void> => {
    await client`
      insert into system_state (key, value)
      values ('installed', to_jsonb(${value}::boolean))
      on conflict (key) do update set value = excluded.value, updated_at = now()
    `;
  };

  /** A live setup token for the happy-path requests. */
  const liveToken = (): Promise<string> => tokens.generateToken();

  // ─── Guard gating ────────────────────────────────────────────────────────────

  it('every step route 404s WITHOUT a token (uniform hiding, not 401/403)', async () => {
    for (const path of Object.values(ROUTES)) {
      await request(app.getHttpServer()).post(path).send({}).expect(404);
    }
  });

  it('every step route 404s POST-INSTALL even with a valid token (lockdown)', async () => {
    const token = await liveToken();
    await setInstalled(true);
    for (const path of Object.values(ROUTES)) {
      await request(app.getHttpServer())
        .post(path)
        .set('X-Setup-Token', token)
        .send({})
        .expect(404);
    }
  });

  // ─── database/test ────────────────────────────────────────────────────────────

  it('database/test returns {ok:true} for the real DB url (guarded, admitted)', async () => {
    const token = await liveToken();
    const res = await request(app.getHttpServer())
      .post(ROUTES.dbTest)
      .set('X-Setup-Token', token)
      .send({ url: process.env.DATABASE_URL })
      .expect(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('database/test returns a CLEAN error for a bad url and NEVER leaks the password', async () => {
    const token = await liveToken();
    const badUrl = 'postgres://baduser:SUPERSECRETPW@127.0.0.1:5440/nope';
    const res = await request(app.getHttpServer())
      .post(ROUTES.dbTest)
      .set('X-Setup-Token', token)
      .send({ url: badUrl })
      .expect(200);
    expect(res.body.ok).toBe(false);
    expect(typeof res.body.error).toBe('string');
    expect(JSON.stringify(res.body)).not.toContain('SUPERSECRETPW');
    expect(JSON.stringify(res.body)).not.toContain('baduser');
  });

  it('database/test rejects a malformed (non-postgres) url with 400', async () => {
    const token = await liveToken();
    await request(app.getHttpServer())
      .post(ROUTES.dbTest)
      .set('X-Setup-Token', token)
      .send({ url: 'http://not-a-db' })
      .expect(400);
  });

  // ─── database/configure (record-only) ─────────────────────────────────────────

  it('database/configure records the mode marker into system_state (record-only)', async () => {
    const token = await liveToken();
    await request(app.getHttpServer())
      .post(ROUTES.dbConfigure)
      .set('X-Setup-Token', token)
      .send({ mode: 'bare_metal' })
      .expect(200, { ok: true });

    const rows = await client<{ value: { mode: string } }[]>`
      select value from system_state where key = 'db_config'`;
    expect(rows[0].value.mode).toBe('bare_metal');
  });

  // ─── smtp/test (throwaway transport, no live singleton) ────────────────────────

  it('smtp/test returns a clean sanitized error for an unreachable host (no creds leaked)', async () => {
    const token = await liveToken();
    const res = await request(app.getHttpServer())
      .post(ROUTES.smtpTest)
      .set('X-Setup-Token', token)
      .send({
        host: '127.0.0.1',
        port: 2, // nothing listening — connection refused, throwaway transport
        secure: false,
        user: 'u',
        pass: 'SMTPSECRETPW',
        from: 'store@example.com',
        to: 'owner@example.com',
      })
      .expect(200);
    expect(res.body.ok).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain('SMTPSECRETPW');
    expect(JSON.stringify(res.body)).not.toContain('owner@example.com');
  }, 15000);

  // ─── smtp/configure persists ciphertext ───────────────────────────────────────

  it('smtp/configure stores the creds as CIPHERTEXT (!= plaintext) that round-trips', async () => {
    const token = await liveToken();
    const creds = {
      host: 'mail.example.com',
      port: 587,
      secure: false,
      user: 'mailer',
      pass: 'SMTP_PLAINTEXT_PW',
      from: 'store@example.com',
    };
    await request(app.getHttpServer())
      .post(ROUTES.smtpConfigure)
      .set('X-Setup-Token', token)
      .send(creds)
      .expect(200, { ok: true });

    const rows = await client<{ ciphertext: string }[]>`
      select ciphertext from tenant_secrets where tenant_id = ${tenantId} and kind = 'smtp'`;
    expect(rows.length).toBe(1);
    // Ciphertext at rest — never the plaintext password.
    expect(rows[0].ciphertext).not.toContain('SMTP_PLAINTEXT_PW');
    // Round-trips under the tenant AAD.
    const decrypted = JSON.parse(aead.decrypt(rows[0].ciphertext, tenantId));
    expect(decrypted.pass).toBe('SMTP_PLAINTEXT_PW');
    expect(decrypted.host).toBe('mail.example.com');
  });

  it('the SMTP secret is AAD-bound to the tenant — a wrong-tenant decrypt fails closed', async () => {
    const token = await liveToken();
    await request(app.getHttpServer())
      .post(ROUTES.smtpConfigure)
      .set('X-Setup-Token', token)
      .send({
        host: 'h',
        port: 25,
        secure: false,
        from: 'f@x.test',
      })
      .expect(200);
    const rows = await client<{ ciphertext: string }[]>`
      select ciphertext from tenant_secrets where tenant_id = ${tenantId} and kind = 'smtp'`;
    expect(() => aead.decrypt(rows[0].ciphertext, uuidv7())).toThrow();
  });

  // ─── payments/configure ───────────────────────────────────────────────────────

  it('payments/configure persists methods in settings + encrypts the Stripe blob (no key leak)', async () => {
    const token = await liveToken();
    const res = await request(app.getHttpServer())
      .post(ROUTES.paymentsConfigure)
      .set('X-Setup-Token', token)
      .send({
        methods: ['stripe', 'manual'],
        stripe: {
          secretKey: 'sk_test_PLAINTEXT_SECRET',
          publishableKey: 'pk_test_PUB',
          webhookSecret: 'whsec_PLAINTEXT',
        },
      })
      .expect(200);
    expect(res.body.ok).toBe(true);
    // The key never appears in the response body.
    expect(JSON.stringify(res.body)).not.toContain('sk_test_PLAINTEXT_SECRET');

    // methods persisted as NON-secret settings.payments
    const tenantRows = await client<{ settings: { payments?: { methods?: string[] } } }[]>`
      select settings from tenants where id = ${tenantId}`;
    expect(tenantRows[0].settings.payments?.methods).toEqual(['stripe', 'manual']);
    // No plaintext key in settings.
    expect(JSON.stringify(tenantRows[0].settings)).not.toContain('sk_test_PLAINTEXT_SECRET');

    // Stripe blob encrypted at rest under kind 'stripe', round-trips.
    const secretRows = await client<{ ciphertext: string }[]>`
      select ciphertext from tenant_secrets where tenant_id = ${tenantId} and kind = 'stripe'`;
    expect(secretRows.length).toBe(1);
    expect(secretRows[0].ciphertext).not.toContain('sk_test_PLAINTEXT_SECRET');
    const decrypted = JSON.parse(aead.decrypt(secretRows[0].ciphertext, tenantId));
    expect(decrypted.secretKey).toBe('sk_test_PLAINTEXT_SECRET');
  }, 15000);

  it('payments/configure with no stripe creds writes methods only (no stripe secret row)', async () => {
    const token = await liveToken();
    await request(app.getHttpServer())
      .post(ROUTES.paymentsConfigure)
      .set('X-Setup-Token', token)
      .send({ methods: ['manual'] })
      .expect(200, { ok: true });
    const secretRows = await client<{ c: number }[]>`
      select count(*)::int as c from tenant_secrets where tenant_id = ${tenantId} and kind = 'stripe'`;
    expect(Number(secretRows[0].c)).toBe(0);
  });
});
