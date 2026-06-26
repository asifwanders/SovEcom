/**
 * SetupOnboardingService UNIT tests.
 *
 * SVG stored-XSS via brand-logo upload defense. A hostile SVG carrying inline <script>
 * could be stored and later served inline. This pins the defense:
 *   - an `image/svg+xml` logo is REJECTED (raster-only),
 *   - a logo whose declared mimetype lies (raster mimetype but SVG/script bytes) is
 *     REJECTED by the byte-sniff (sharp probe), never trusting the mimetype,
 *   - a genuine raster logo is still ACCEPTED and uploaded.
 */
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import sharp from 'sharp';
import type { Express } from 'express';
import { SetupOnboardingService } from './setup-onboarding.service';
import type { DatabaseService } from '../database/database.service';
import type { TenantSettingsService } from '../taxes/tenant-settings.service';
import type { ViesService } from '../customers/vies/vies.service';
import type { StorageService } from '../storage/storage.service';
import type { ThemesService, InstalledThemeView } from '../modules/themes.service';
import type { ModulesService, InstalledModuleView } from '../modules/modules.service';
import type { ModuleRuntimeService } from '../modules/runtime/module-runtime.service';

const TENANT = '00000000-0000-7000-8000-0000000000aa';

/** A seeded installed-theme view (the shape ThemesService.list returns). */
function themeView(name: string, isActive: boolean): InstalledThemeView {
  return {
    id: `id-${name}`,
    name,
    version: '1.0.0',
    slots: [],
    settings: {},
    isActive,
    installedAt: new Date('2026-01-01T00:00:00.000Z'),
  };
}

/** DatabaseService fake backing the non-tax mergeSettings read-merge-write. */
function makeDb(): DatabaseService {
  return {
    db: {
      select: () => ({
        from: () => ({ where: () => ({ limit: () => Promise.resolve([{ settings: {} }]) }) }),
      }),
      update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
    },
  } as unknown as DatabaseService;
}

function makeService(
  uploadSpy: jest.Mock,
  themes: Partial<ThemesService> = {},
  modules: Partial<ModulesService> = {},
  runtime: Partial<ModuleRuntimeService> = {},
): SetupOnboardingService {
  const settings = { invalidate: () => {} } as unknown as TenantSettingsService;
  const vies = {} as unknown as ViesService;
  const storage = {
    upload: uploadSpy,
  } as unknown as StorageService;
  return new SetupOnboardingService(
    makeDb(),
    settings,
    vies,
    storage,
    themes as unknown as ThemesService,
    modules as unknown as ModulesService,
    runtime as unknown as ModuleRuntimeService,
  );
}

/** A minimal installed-module view (the shape ModulesService.list / install returns). */
function moduleView(name: string, enabled: boolean): InstalledModuleView {
  return {
    id: `id-${name}`,
    name,
    version: '0.1.0',
    grantedPermissions: [],
    slots: [],
    enabled,
    installedAt: new Date('2026-01-01T00:00:00.000Z'),
  };
}

/** Build a minimal Multer file from a buffer + declared mimetype. */
function file(buffer: Buffer, mimetype: string): Express.Multer.File {
  return {
    buffer,
    mimetype,
    size: buffer.length,
    originalname: 'logo',
    fieldname: 'logo',
    encoding: '7bit',
  } as unknown as Express.Multer.File;
}

async function rasterPng(): Promise<Buffer> {
  return sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 20, b: 30 } },
  })
    .png()
    .toBuffer();
}

describe('SetupOnboardingService.configureBrand — SVG XSS defense', () => {
  it('rejects an image/svg+xml logo (raster-only)', async () => {
    const upload = jest.fn();
    const svc = makeService(upload);
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>',
    );
    await expect(svc.configureBrand(TENANT, {}, file(svg, 'image/svg+xml'))).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(upload).not.toHaveBeenCalled();
  });

  it('rejects SVG bytes even when the mimetype LIES that it is a raster PNG', async () => {
    const upload = jest.fn();
    const svc = makeService(upload);
    const svgBytes = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>',
    );
    await expect(
      svc.configureBrand(TENANT, {}, file(svgBytes, 'image/png')),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(upload).not.toHaveBeenCalled();
  });

  it('accepts a genuine raster (PNG) logo and uploads it', async () => {
    const upload = jest.fn().mockResolvedValue({ key: 'brand/x/logo.png' });
    const svc = makeService(upload);
    const png = await rasterPng();
    const res = await svc.configureBrand(TENANT, {}, file(png, 'image/png'));
    expect(res.logoKey).toBe('brand/x/logo.png');
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('records colours-only when no logo is supplied', async () => {
    const upload = jest.fn();
    const svc = makeService(upload);
    const res = await svc.configureBrand(TENANT, { primary: '#112233' }, undefined);
    expect(res.logoKey).toBeNull();
    expect(upload).not.toHaveBeenCalled();
  });
});

describe('SetupOnboardingService — themes (real installed_themes via ThemesService)', () => {
  it('lists the seeded default + boutique themes (projected to the wizard card shape)', async () => {
    const list = jest
      .fn()
      .mockResolvedValue([themeView('default', true), themeView('boutique', false)]);
    const svc = makeService(jest.fn(), { list });
    const res = await svc.listThemes(TENANT);
    expect(list).toHaveBeenCalledWith(TENANT);
    expect(res.themes).toEqual([
      { id: 'default', name: 'default', preview: 'placeholder' },
      { id: 'boutique', name: 'boutique', preview: 'placeholder' },
    ]);
  });

  it('activating boutique delegates to ThemesService.activate (flips is_active)', async () => {
    const activate = jest.fn().mockResolvedValue(themeView('boutique', true));
    const svc = makeService(jest.fn(), { activate });
    await svc.activateTheme(TENANT, 'boutique');
    expect(activate).toHaveBeenCalledWith(TENANT, 'boutique');
  });

  it('activating an unknown theme propagates the 404 (NotFoundException)', async () => {
    const activate = jest
      .fn()
      .mockRejectedValue(new NotFoundException('theme not installed: nope'));
    const svc = makeService(jest.fn(), { activate });
    await expect(svc.activateTheme(TENANT, 'nope')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('SetupOnboardingService — bundled modules (real install + enable)', () => {
  let prevPath: string | undefined;
  let bundledDir: string;

  // Point BUNDLED_MODULES_PATH at a temp dir holding dummy `.tgz` files, so the service's
  // file read resolves (the mocked ModulesService ignores the bytes). This keeps the unit
  // test off the real packed artifacts while still exercising the FS path.
  beforeAll(() => {
    prevPath = process.env['BUNDLED_MODULES_PATH'];
    bundledDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundled-modules-spec-'));
    process.env['BUNDLED_MODULES_PATH'] = bundledDir;
    for (const id of ['reviews', 'recently-viewed', 'wishlist', 'notify-back-in-stock']) {
      fs.writeFileSync(path.join(bundledDir, `${id}.tgz`), Buffer.from(`fake-tgz-${id}`));
      fs.writeFileSync(
        path.join(bundledDir, `${id}.module.json`),
        JSON.stringify({ displayName: `Disp ${id}`, permissions: ['read:products'], slots: [] }),
      );
    }
  });

  afterAll(() => {
    if (prevPath === undefined) delete process.env['BUNDLED_MODULES_PATH'];
    else process.env['BUNDLED_MODULES_PATH'] = prevPath;
    fs.rmSync(bundledDir, { recursive: true, force: true });
  });

  it('lists the four built-ins with manifest metadata + installed flags', async () => {
    const list = jest.fn().mockResolvedValue([moduleView('reviews', true)]);
    const svc = makeService(jest.fn(), {}, { list });
    const res = await svc.listModules(TENANT);
    expect(list).toHaveBeenCalledWith(TENANT);
    const ids = res.modules.map((m) => m.id).sort();
    expect(ids).toEqual(['notify-back-in-stock', 'recently-viewed', 'reviews', 'wishlist'].sort());
    const reviews = res.modules.find((m) => m.id === 'reviews')!;
    expect(reviews.displayName).toBe('Disp reviews');
    expect(reviews.description.length).toBeGreaterThan(0);
    expect(reviews.permissions).toContain('read:products');
    expect(reviews.installed).toBe(true);
    // A built-in that is NOT installed shows installed=false.
    expect(res.modules.find((m) => m.id === 'wishlist')!.installed).toBe(false);
  });

  it('installs + enables a valid built-in, returning its id', async () => {
    const install = jest.fn().mockResolvedValue(moduleView('reviews', true));
    const enable = jest.fn().mockResolvedValue(undefined);
    const isRunning = jest.fn().mockReturnValue(false);
    const svc = makeService(jest.fn(), {}, { install }, { enable, isRunning });

    const res = await svc.installModules(TENANT, ['reviews']);

    expect(install).toHaveBeenCalledTimes(1);
    // install is called with (tenantId, Buffer, grantedPermissions[]).
    const [tid, buf, granted] = install.mock.calls[0];
    expect(tid).toBe(TENANT);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(granted).toEqual(['read:products']); // the manifest's own declared perms.
    expect(enable).toHaveBeenCalledWith(TENANT, 'reviews');
    expect(res.installed).toEqual(['reviews']);
    expect(res.failed).toEqual([]);
  });

  it('REJECTS an unknown / traversing id with NO install (BadRequest, allowlist gate)', async () => {
    const install = jest.fn();
    const enable = jest.fn();
    const svc = makeService(jest.fn(), {}, { install }, { enable });

    await expect(svc.installModules(TENANT, ['reviews', '../evil'])).rejects.toBeInstanceOf(
      BadRequestException,
    );
    // The allowlist is validated BEFORE any FS/ingest — nothing was installed or enabled.
    expect(install).not.toHaveBeenCalled();
    expect(enable).not.toHaveBeenCalled();

    await expect(svc.installModules(TENANT, ['totally-made-up'])).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(install).not.toHaveBeenCalled();
  });

  it('is idempotent: an already-installed module (409) is a no-op SUCCESS, still enabled', async () => {
    // ModulesService.install throws ConflictException when the (tenant,name) row exists.
    const install = jest.fn().mockRejectedValue(new ConflictException('module already installed'));
    const enable = jest.fn().mockResolvedValue(undefined);
    const isRunning = jest.fn().mockReturnValue(false);
    const svc = makeService(jest.fn(), {}, { install }, { enable, isRunning });

    const res = await svc.installModules(TENANT, ['reviews']);

    expect(res.installed).toEqual(['reviews']); // reported as installed (no-op success).
    // A 409 install does NOT abort enable — the module ends up enabled regardless.
    expect(enable).toHaveBeenCalledWith(TENANT, 'reviews');
  });

  it('skips enable when the worker is already running (idempotent enable)', async () => {
    const install = jest.fn().mockRejectedValue(new ConflictException('module already installed'));
    const enable = jest.fn().mockResolvedValue(undefined);
    const isRunning = jest.fn().mockReturnValue(true); // already enabled + running.
    const svc = makeService(jest.fn(), {}, { install }, { enable, isRunning });

    const res = await svc.installModules(TENANT, ['reviews']);
    expect(res.installed).toEqual(['reviews']);
    expect(enable).not.toHaveBeenCalled();
  });

  it('isolates a per-module failure: one bad install does not abort the rest; failure surfaced in failed[] (S1)', async () => {
    const install = jest
      .fn()
      .mockResolvedValueOnce(moduleView('reviews', true)) // reviews installs
      .mockRejectedValueOnce(new Error('boom — ingest blew up')); // wishlist fails
    const enable = jest.fn().mockResolvedValue(undefined);
    const isRunning = jest.fn().mockReturnValue(false);
    const svc = makeService(jest.fn(), {}, { install }, { enable, isRunning });

    const res = await svc.installModules(TENANT, ['reviews', 'wishlist']);

    // The success is reported in installed[]; the failure is isolated AND surfaced in failed[] —
    // NEVER silently swallowed into a claimed success (S1).
    expect(res.installed).toEqual(['reviews']);
    expect(res.failed).toEqual(['wishlist']);
    expect(enable).toHaveBeenCalledWith(TENANT, 'reviews');
    expect(enable).not.toHaveBeenCalledWith(TENANT, 'wishlist');
  });

  it('a MISSING/corrupt sidecar manifest FAILS the install — never a zero-perm install (S2)', async () => {
    // Remove the sidecar for `reviews`: readBundledManifest → null. The trusted built-in must FAIL
    // (land in failed[]), NOT install with an empty `[]` grant (a dead, permission-less module).
    const sidecar = path.join(bundledDir, 'reviews.module.json');
    const saved = fs.readFileSync(sidecar);
    fs.rmSync(sidecar);
    try {
      const install = jest.fn().mockResolvedValue(moduleView('reviews', true));
      const enable = jest.fn().mockResolvedValue(undefined);
      const isRunning = jest.fn().mockReturnValue(false);
      const svc = makeService(jest.fn(), {}, { install }, { enable, isRunning });

      const res = await svc.installModules(TENANT, ['reviews']);

      expect(res.installed).toEqual([]);
      expect(res.failed).toEqual(['reviews']);
      // The install was NEVER attempted with an empty grant — it failed BEFORE reaching install.
      expect(install).not.toHaveBeenCalled();
      expect(enable).not.toHaveBeenCalled();
    } finally {
      fs.writeFileSync(sidecar, saved); // restore for the other tests.
    }
  });

  it('an empty selection installs nothing and succeeds', async () => {
    const install = jest.fn();
    const enable = jest.fn();
    const svc = makeService(jest.fn(), {}, { install }, { enable });
    const res = await svc.installModules(TENANT, []);
    expect(res.installed).toEqual([]);
    expect(res.failed).toEqual([]);
    expect(install).not.toHaveBeenCalled();
  });
});
