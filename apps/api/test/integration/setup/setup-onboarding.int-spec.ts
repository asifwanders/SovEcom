/**
 * Setup onboarding endpoints integration.
 * Real Postgres + Redis. Boots the full AppModule with the VIES_CLIENT overridden by a
 * controllable mock (no network egress), seeds ONE tenant + `default_tenant_id`, and
 * drives the tax/compliance/brand steps + the REAL themes list/activate behind
 * {@link SetupTokenGuard}.
 *
 * Covers:
 *   - GUARD GATING: every step route is 404 without a live token + 404 post-install;
 *   - tax/configure: defaults eu_vat for an EU country + none for non-EU; EU + none → 422
 *     (the SHARED guardrail); eu_vat persists eu_vat_registration + the VIES status;
 * business_country + default_currency land in settings;
 *   - compliance/configure persists settings.compliance (cookie consent locked on);
 *   - brand: a multipart logo upload stores a storage key + colours into settings.brand;
 *   - themes: GET lists the seeded default + boutique; activate boutique flips is_active;
 *     activate-unknown → 404;
 *   - modules: GET lists the platform's BUILT-IN catalog (with installed flags); POST install of a
 *     valid bundled id runs the REAL ingest (GuardedTarExtractor + manifest re-verify) → writes the
 *     installed_modules row + enables (enable stubbed — no real worker fork); an unknown/`../evil`
 *     id → 400 with NO ingest/FS access + NO row; idempotent re-install → no-op success (not 409).
 *     ModuleRuntimeService is overridden so enable does not fork dist/worker-entry.js (absent here).
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
import sharp from 'sharp';
import { uuidv7 } from 'uuidv7';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as zlib from 'zlib';
import * as schema from '../../../src/database/schema';
import { seedBundledThemes } from '../../../src/database/seeds/themes/seed-themes';
import { AppModule } from '../../../src/app.module';
import { AllExceptionsFilter } from '../../../src/common/filters/all-exceptions.filter';
import { SetupTokenService } from '../../../src/setup/setup-token.service';
import {
  VIES_CLIENT,
  type ViesClient,
  type ViesCheckResult,
} from '../../../src/customers/vies/vies.client';
import { ModuleRuntimeService } from '../../../src/modules/runtime/module-runtime.service';

const MIGRATIONS = 'src/database/migrations';

/** Controllable VIES mock — `.queue(result)` sets the next outcome; default unreachable. */
class MockViesClient implements ViesClient {
  calls = 0;
  private next: ViesCheckResult[] = [];
  fallback: ViesCheckResult = { status: 'unreachable' };
  queue(result: ViesCheckResult): void {
    this.next.push(result);
  }
  reset(): void {
    this.calls = 0;
    this.next = [];
  }
  check(): Promise<ViesCheckResult> {
    this.calls += 1;
    return Promise.resolve(this.next.shift() ?? this.fallback);
  }
}

const ROUTES = {
  tax: '/setup/v1/tax/configure',
  compliance: '/setup/v1/compliance/configure',
  brand: '/setup/v1/brand',
  themes: '/setup/v1/themes',
  themesActivate: '/setup/v1/themes/activate',
  modules: '/setup/v1/modules',
  modulesInstall: '/setup/v1/modules/install',
} as const;

// ── minimal USTAR tar writer (mirrors modules.int-spec.ts) — builds a VALID bundled `.tgz`
//    so the setup install path exercises the REAL ingest (GuardedTarExtractor + manifest verify),
//    not a stub. The packed `.tgz` lands in a temp BUNDLED_MODULES_PATH (so the test never depends
//    on the gitignored apps/api/bundled-modules dir being present in CI).
const TAR_BLOCK = 512;
interface TarEntry {
  name: string;
  type?: '0' | '5';
  data?: Buffer;
}
function tarOctal(value: number, len: number): string {
  return value.toString(8).padStart(len - 1, '0') + '\0';
}
function tarHeader(entry: TarEntry): Buffer {
  const buf = Buffer.alloc(TAR_BLOCK, 0);
  buf.write(entry.name.slice(0, 100), 0, 'utf8');
  buf.write(entry.type === '5' ? '0000755\0' : '0000644\0', 100, 'ascii');
  buf.write('0000000\0', 108, 'ascii');
  buf.write('0000000\0', 116, 'ascii');
  const size = entry.data?.length ?? 0;
  buf.write(tarOctal(size, 12), 124, 'ascii');
  buf.write(tarOctal(0, 12), 136, 'ascii');
  buf.write('        ', 148, 'ascii');
  buf.write(entry.type ?? '0', 156, 'ascii');
  buf.write('ustar\0', 257, 'ascii');
  buf.write('00', 263, 'ascii');
  let sum = 0;
  for (let i = 0; i < TAR_BLOCK; i++) sum += buf[i] ?? 0;
  buf.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return buf;
}
function buildTar(entries: TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    parts.push(tarHeader(e));
    if (e.type === '5') continue;
    const data = e.data ?? Buffer.alloc(0);
    parts.push(data);
    const pad = (TAR_BLOCK - (data.length % TAR_BLOCK)) % TAR_BLOCK;
    if (pad) parts.push(Buffer.alloc(pad, 0));
  }
  parts.push(Buffer.alloc(TAR_BLOCK * 2, 0));
  return Buffer.concat(parts);
}

/** The bundled id under test — fewest permissions, no email/event surface (cheapest to ingest). */
const BUNDLED_TEST_ID = 'recently-viewed';
const BUNDLED_TEST_MANIFEST = {
  name: BUNDLED_TEST_ID,
  displayName: 'Recently viewed',
  version: '0.1.0',
  compatibleCore: '^1.0.0',
  permissions: ['write:own_tables', 'read:products'],
  slots: [{ slot: 'home-page-bottom', component: 'product-carousel' }],
  tables: ['mod_recently-viewed_views'],
};

/** Build a valid bundled `.tgz` (gzip'd USTAR) for the module under test. */
function bundledTgz(): Buffer {
  return zlib.gzipSync(
    buildTar([
      { name: 'package/', type: '5' },
      {
        name: 'package/sovecom.module.json',
        data: Buffer.from(JSON.stringify(BUNDLED_TEST_MANIFEST)),
      },
      { name: 'package/index.js', data: Buffer.from('module.exports = { default: {} };\n') },
    ]),
  );
}

describe('Setup onboarding endpoints (integration)', () => {
  let app: INestApplication;
  let client: ReturnType<typeof postgres>;
  let db: PostgresJsDatabase<typeof schema>;
  let redis: Redis;
  let tokens: SetupTokenService;
  let vies: MockViesClient;
  let tenantId: string;
  let bundledDir: string;
  let prevBundledPath: string | undefined;
  // Records (tenantId, name) enable calls so the test can assert enable ran WITHOUT forking a real
  // sandboxed worker (the happy-path fork loads dist/worker-entry.js, absent in ts-jest tests).
  const enableCalls: { tenantId: string; name: string }[] = [];

  /** A no-op ModuleRuntimeService: enable just records; install/idempotency are the real path. */
  const fakeRuntime = {
    enable: async (t: string, name: string) => {
      enableCalls.push({ tenantId: t, name });
    },
    isRunning: () => false,
    disable: async () => undefined,
  };

  beforeAll(async () => {
    process.env.JWT_SECRET ??= 'integration-jwt-secret-integration-jwt-secret-32+';
    process.env.MASTER_KEY ??= Buffer.alloc(32, 0x2a).toString('base64');
    process.env.NODE_ENV = 'test';

    // Pack a valid bundled `.tgz` (+ its manifest) into a temp BUNDLED_MODULES_PATH so the install
    // path reads a real artifact without depending on the gitignored apps/api/bundled-modules dir.
    bundledDir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-bundled-modules-'));
    prevBundledPath = process.env['BUNDLED_MODULES_PATH'];
    process.env['BUNDLED_MODULES_PATH'] = bundledDir;
    fs.writeFileSync(path.join(bundledDir, `${BUNDLED_TEST_ID}.tgz`), bundledTgz());
    fs.writeFileSync(
      path.join(bundledDir, `${BUNDLED_TEST_ID}.module.json`),
      JSON.stringify(BUNDLED_TEST_MANIFEST),
    );

    const url = process.env.DATABASE_URL as string;
    client = postgres(url, { max: 4, onnotice: () => {} });
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS });
    redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
    vies = new MockViesClient();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(VIES_CLIENT)
      .useValue(vies)
      // Override the runtime so enable does NOT fork a real worker (no dist/worker-entry.js in
      // ts-jest); the install path (ingest + persist) stays REAL and is what we assert on.
      .overrideProvider(ModuleRuntimeService)
      .useValue(fakeRuntime)
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
    if (prevBundledPath === undefined) delete process.env['BUNDLED_MODULES_PATH'];
    else process.env['BUNDLED_MODULES_PATH'] = prevBundledPath;
    if (bundledDir) fs.rmSync(bundledDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await client.unsafe(`TRUNCATE TABLE setup_tokens RESTART IDENTITY`);
    await client.unsafe(`TRUNCATE TABLE tenants CASCADE`);
    await client.unsafe(
      `DELETE FROM system_state WHERE key IN ('installed','default_tenant_id','db_config')`,
    );
    await redis.flushdb();
    vies.reset();
    enableCalls.length = 0;

    tenantId = uuidv7();
    await client`insert into tenants (id, name, slug) values (${tenantId}, 'T', ${'t-' + tenantId})`;
    await client`insert into system_state (key, value) values ('default_tenant_id', to_jsonb(${tenantId}::text))`;
    // Seed the bundled themes (default + boutique) into installed_themes for this tenant, so
    // the REAL themes step lists/activates them (the same seed the install script runs). The
    // TRUNCATE ... CASCADE above already cleared installed_themes for the recreated tenant.
    await seedBundledThemes(db, tenantId);
    await setInstalled(false);
    const state = app.get(
      (await import('../../../src/setup/setup-state.service')).SetupStateService,
      { strict: false },
    );
    (state as unknown as { defaultTenantId: string | null }).defaultTenantId = null;
    // The TenantSettingsService caches the settings JSONB per tenant across tests.
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

  const tenantSettings = async (): Promise<Record<string, any>> => {
    const rows = await client<{ settings: Record<string, any> }[]>`
      select settings from tenants where id = ${tenantId}`;
    return rows[0].settings ?? {};
  };

  // ─── Guard gating ────────────────────────────────────────────────────────────

  it('POST step routes 404 WITHOUT a token (uniform hiding)', async () => {
    for (const path of [ROUTES.tax, ROUTES.compliance, ROUTES.themesActivate]) {
      await request(app.getHttpServer()).post(path).send({}).expect(404);
    }
    await request(app.getHttpServer()).get(ROUTES.themes).expect(404);
  });

  it('POST step routes 404 POST-INSTALL even with a valid token (lockdown)', async () => {
    const token = await liveToken();
    await setInstalled(true);
    await request(app.getHttpServer())
      .post(ROUTES.tax)
      .set('X-Setup-Token', token)
      .send({ businessCountry: 'US', defaultCurrency: 'USD' })
      .expect(404);
    await request(app.getHttpServer()).get(ROUTES.themes).set('X-Setup-Token', token).expect(404);
  });

  // ─── tax/configure ────────────────────────────────────────────────────────────

  it('defaults tax_mode to eu_vat for an EU business country (VIES valid recorded)', async () => {
    const token = await liveToken();
    vies.queue({ status: 'valid', consultationRef: 'REF123' });
    const res = await request(app.getHttpServer())
      .post(ROUTES.tax)
      .set('X-Setup-Token', token)
      .send({ businessCountry: 'fr', defaultCurrency: 'eur', vatNumber: 'FR12345678901' })
      .expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.taxMode).toBe('eu_vat');
    expect(res.body.vatStatus).toBe('valid');
    expect(vies.calls).toBe(1);

    const s = await tenantSettings();
    expect(s.tax_mode).toBe('eu_vat');
    expect(s.eu_vat_registration.origin_country).toBe('FR');
    expect(s.eu_vat_registration.vat_number).toBe('FR12345678901');
    // Onboarding profile lands in settings (normalised upper-case).
    expect(s.business_country).toBe('FR');
    expect(s.default_currency).toBe('EUR');
  });

  it('defaults tax_mode to none for a non-EU business country (no VIES call)', async () => {
    const token = await liveToken();
    const res = await request(app.getHttpServer())
      .post(ROUTES.tax)
      .set('X-Setup-Token', token)
      .send({ businessCountry: 'US', defaultCurrency: 'USD' })
      .expect(200);
    expect(res.body.taxMode).toBe('none');
    expect(res.body.vatStatus).toBeUndefined();
    expect(vies.calls).toBe(0);

    const s = await tenantSettings();
    expect(s.tax_mode).toBe('none');
    expect(s.business_country).toBe('US');
    expect(s.default_currency).toBe('USD');
  });

  it('EU business country + explicit tax_mode none → 422 (shared EU guardrail)', async () => {
    const token = await liveToken();
    await request(app.getHttpServer())
      .post(ROUTES.tax)
      .set('X-Setup-Token', token)
      .send({ businessCountry: 'DE', defaultCurrency: 'EUR', taxMode: 'none' })
      .expect(422);
    // Nothing persisted (the write is after the guardrail).
    const s = await tenantSettings();
    expect(s.tax_mode).toBeUndefined();
  });

  it('eu_vat without a VAT number → 400', async () => {
    const token = await liveToken();
    await request(app.getHttpServer())
      .post(ROUTES.tax)
      .set('X-Setup-Token', token)
      .send({ businessCountry: 'FR', defaultCurrency: 'EUR', taxMode: 'eu_vat' })
      .expect(400);
  });

  it('records the VIES tri-state status (unreachable) without hard-failing', async () => {
    const token = await liveToken();
    vies.queue({ status: 'unreachable' });
    const res = await request(app.getHttpServer())
      .post(ROUTES.tax)
      .set('X-Setup-Token', token)
      .send({ businessCountry: 'IT', defaultCurrency: 'EUR', vatNumber: 'IT00000000000' })
      .expect(200);
    expect(res.body.taxMode).toBe('eu_vat');
    expect(res.body.vatStatus).toBe('unreachable');
  });

  // ─── compliance/configure ──────────────────────────────────────────────────────

  it('compliance/configure persists settings.compliance + the real settings.analytics', async () => {
    const token = await liveToken();
    await request(app.getHttpServer())
      .post(ROUTES.compliance)
      .set('X-Setup-Token', token)
      .send({
        cookieConsent: true,
        analytics: { plausible: true, plausibleDomain: 'shop.example.com', ga: { id: 'G-XYZ' } },
      })
      .expect(200, { ok: true });

    const s = await tenantSettings();
    expect(s.compliance.cookie_consent).toBe(true);
    expect(s.compliance.analytics.plausible).toBe(true);
    expect(s.compliance.analytics.ga.id).toBe('G-XYZ');
    expect(s.compliance.analytics.meta).toBeNull();
    // the analytics ids are mirrored into settings.analytics (what the storefront reads).
    expect(s.analytics.plausible_domain).toBe('shop.example.com');
    expect(s.analytics.ga4_id).toBe('G-XYZ');
  });

  it('compliance/configure rejects cookieConsent=false (locked literal true)', async () => {
    const token = await liveToken();
    await request(app.getHttpServer())
      .post(ROUTES.compliance)
      .set('X-Setup-Token', token)
      .send({ cookieConsent: false })
      .expect(400);
  });

  // ─── brand (multipart) ──────────────────────────────────────────────────────────

  it('brand stores a logo storage key + colours into settings.brand', async () => {
    const token = await liveToken();
    // A GENUINE raster PNG: the brand path byte-sniffs the upload with sharp
    // (never trust the client mimetype), so a bare PNG magic-number buffer no longer passes.
    const png = await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .png()
      .toBuffer();
    const res = await request(app.getHttpServer())
      .post(ROUTES.brand)
      .set('X-Setup-Token', token)
      .field('primary', '#112233')
      .field('secondary', '#445566')
      .field('gradient', 'true')
      .attach('logo', png, { filename: 'logo.png', contentType: 'image/png' })
      .expect(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.logoKey).toBe('string');
    expect(res.body.logoKey).toContain(tenantId);

    const s = await tenantSettings();
    expect(s.brand.logo_key).toBe(res.body.logoKey);
    expect(s.brand.colors.primary).toBe('#112233');
    expect(s.brand.colors.secondary).toBe('#445566');
    expect(s.brand.gradient).toBe(true);
  });

  it('brand without a logo records colours only (logoKey null)', async () => {
    const token = await liveToken();
    const res = await request(app.getHttpServer())
      .post(ROUTES.brand)
      .set('X-Setup-Token', token)
      .field('primary', '#abcdef')
      .expect(200);
    expect(res.body.logoKey).toBeNull();
    const s = await tenantSettings();
    expect(s.brand.colors.primary).toBe('#abcdef');
  });

  it('brand rejects a non-image logo (415-class → 400)', async () => {
    const token = await liveToken();
    await request(app.getHttpServer())
      .post(ROUTES.brand)
      .set('X-Setup-Token', token)
      .attach('logo', Buffer.from('not-an-image'), {
        filename: 'evil.txt',
        contentType: 'text/plain',
      })
      .expect(400);
  });

  // An SVG logo is a stored-XSS vector (it can carry inline <script>) and is
  // served inline/publicly, so the brand path must REJECT it even with an image mimetype.
  it('brand rejects an SVG logo (raster-only — stored-XSS defense)', async () => {
    const token = await liveToken();
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>',
    );
    await request(app.getHttpServer())
      .post(ROUTES.brand)
      .set('X-Setup-Token', token)
      .attach('logo', svg, { filename: 'logo.svg', contentType: 'image/svg+xml' })
      .expect(400);
  });

  // ─── themes (REAL — installed_themes) ───────────────────────────────────────────

  /** The is_active flag for a named theme in this tenant's installed_themes. */
  const themeActive = async (name: string): Promise<boolean | undefined> => {
    const rows = await client<{ is_active: boolean }[]>`
      select is_active from installed_themes where tenant_id = ${tenantId} and name = ${name}`;
    return rows[0]?.is_active;
  };

  it('GET themes lists the seeded default + boutique themes', async () => {
    const token = await liveToken();
    const res = await request(app.getHttpServer())
      .get(ROUTES.themes)
      .set('X-Setup-Token', token)
      .expect(200);
    const ids = (res.body.themes as { id: string }[]).map((t) => t.id).sort();
    expect(ids).toEqual(['boutique', 'default']);
  });

  it('themes/activate flips is_active to boutique; rejects an uninstalled theme → 404', async () => {
    const token = await liveToken();
    // Seed leaves `default` active; activating boutique must flip the active flag.
    expect(await themeActive('default')).toBe(true);
    await request(app.getHttpServer())
      .post(ROUTES.themesActivate)
      .set('X-Setup-Token', token)
      .send({ themeId: 'boutique' })
      .expect(200, { ok: true });
    expect(await themeActive('boutique')).toBe(true);
    expect(await themeActive('default')).toBe(false);

    // An unknown/uninstalled theme is a 404 (the service's NotFoundException).
    await request(app.getHttpServer())
      .post(ROUTES.themesActivate)
      .set('X-Setup-Token', token)
      .send({ themeId: 'fancy-paid-theme' })
      .expect(404);
  });

  // ─── modules (REAL — bundled allowlist install + enable) ─────────────────────────

  /** Installed-module rows for this tenant. */
  const installedModuleNames = async (): Promise<string[]> => {
    const rows = await client<{ name: string }[]>`
      select name from installed_modules where tenant_id = ${tenantId} order by name`;
    return rows.map((r) => r.name);
  };

  it('GET modules 404s WITHOUT a token; 404s POST-INSTALL even with a token', async () => {
    await request(app.getHttpServer()).get(ROUTES.modules).expect(404);
    await request(app.getHttpServer())
      .post(ROUTES.modulesInstall)
      .send({ moduleIds: [] })
      .expect(404);
    const token = await liveToken();
    await setInstalled(true);
    await request(app.getHttpServer()).get(ROUTES.modules).set('X-Setup-Token', token).expect(404);
    await request(app.getHttpServer())
      .post(ROUTES.modulesInstall)
      .set('X-Setup-Token', token)
      .send({ moduleIds: [BUNDLED_TEST_ID] })
      .expect(404);
  });

  it('GET modules lists the platform built-ins with manifest metadata + installed flags', async () => {
    const token = await liveToken();
    const res = await request(app.getHttpServer())
      .get(ROUTES.modules)
      .set('X-Setup-Token', token)
      .expect(200);
    const ids = (res.body.modules as { id: string }[]).map((m) => m.id).sort();
    expect(ids).toEqual(['notify-back-in-stock', 'recently-viewed', 'reviews', 'wishlist'].sort());
    const card = (
      res.body.modules as { id: string; installed: boolean; description: string }[]
    ).find((m) => m.id === BUNDLED_TEST_ID)!;
    expect(card.installed).toBe(false); // nothing installed yet.
    expect(card.description.length).toBeGreaterThan(0);
  });

  it('POST install of a valid bundled id installs (real ingest) + enables; idempotent re-run', async () => {
    const token = await liveToken();
    const res = await request(app.getHttpServer())
      .post(ROUTES.modulesInstall)
      .set('X-Setup-Token', token)
      .send({ moduleIds: [BUNDLED_TEST_ID] })
      .expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.installed).toEqual([BUNDLED_TEST_ID]);
    expect(res.body.failed).toEqual([]); // S1: a clean install reports no failures.
    // The REAL install path wrote the registry row (re-extracted + re-verified manifest).
    expect(await installedModuleNames()).toEqual([BUNDLED_TEST_ID]);
    // Enable ran (recorded by the fake runtime — no real worker fork).
    expect(enableCalls).toContainEqual({ tenantId, name: BUNDLED_TEST_ID });

    // A re-list now shows it installed.
    const list = await request(app.getHttpServer())
      .get(ROUTES.modules)
      .set('X-Setup-Token', token)
      .expect(200);
    expect(
      (list.body.modules as { id: string; installed: boolean }[]).find(
        (m) => m.id === BUNDLED_TEST_ID,
      )!.installed,
    ).toBe(true);

    // IDEMPOTENT: re-installing the SAME id is a no-op SUCCESS (NOT a 409), still one row.
    const again = await request(app.getHttpServer())
      .post(ROUTES.modulesInstall)
      .set('X-Setup-Token', token)
      .send({ moduleIds: [BUNDLED_TEST_ID] })
      .expect(200);
    expect(again.body.installed).toEqual([BUNDLED_TEST_ID]);
    expect(await installedModuleNames()).toEqual([BUNDLED_TEST_ID]);
  });

  it('POST install REJECTS an unknown / traversing id (400) with NO ingest + NO row', async () => {
    const token = await liveToken();
    // An unknown built-in name.
    await request(app.getHttpServer())
      .post(ROUTES.modulesInstall)
      .set('X-Setup-Token', token)
      .send({ moduleIds: ['totally-made-up'] })
      .expect(400);
    expect(await installedModuleNames()).toEqual([]);
    expect(enableCalls).toEqual([]);

    // A path-traversing name — rejected by the allowlist BEFORE any filesystem/ingest access.
    await request(app.getHttpServer())
      .post(ROUTES.modulesInstall)
      .set('X-Setup-Token', token)
      .send({ moduleIds: ['../evil'] })
      .expect(400);
    expect(await installedModuleNames()).toEqual([]);

    // A batch with ONE bad id is rejected WHOLESALE — the valid id is NOT installed either.
    await request(app.getHttpServer())
      .post(ROUTES.modulesInstall)
      .set('X-Setup-Token', token)
      .send({ moduleIds: [BUNDLED_TEST_ID, '../evil'] })
      .expect(400);
    expect(await installedModuleNames()).toEqual([]);
    expect(enableCalls).toEqual([]);
  });

  it('POST install with a MISSING sidecar manifest → that id in failed[], NO zero-perm row (S2)', async () => {
    const token = await liveToken();
    // Temporarily remove the packed `<id>.module.json` so readBundledManifest yields null. A trusted
    // built-in with a missing sidecar is a broken package — it must FAIL, not install permission-less.
    const sidecar = path.join(bundledDir, `${BUNDLED_TEST_ID}.module.json`);
    const saved = fs.readFileSync(sidecar);
    fs.rmSync(sidecar);
    try {
      const res = await request(app.getHttpServer())
        .post(ROUTES.modulesInstall)
        .set('X-Setup-Token', token)
        .send({ moduleIds: [BUNDLED_TEST_ID] })
        .expect(200);
      expect(res.body.installed).toEqual([]);
      expect(res.body.failed).toEqual([BUNDLED_TEST_ID]);
      // No row was written (the install was never attempted with an empty grant), enable never ran.
      expect(await installedModuleNames()).toEqual([]);
      expect(enableCalls).toEqual([]);
    } finally {
      fs.writeFileSync(sidecar, saved); // restore for the remaining tests.
    }
  });
});
