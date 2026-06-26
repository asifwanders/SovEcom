/**
 * ThemesService unit tests.
 *
 * The repo + ingest service are mocked; these tests pin the install/activate/settings/uninstall
 * invariants in isolation:
 *   - install claims the `(tenant, name)` row BEFORE placing files (insert precedes commit), and
 *     a `(tenant, name)` conflict becomes a 409 (no update) WITHOUT placing files;
 *   - a fresh install never auto-activates;
 *   - activate / setSettings / uninstall on a missing theme are 404s;
 *   - on a persistence failure the ingested per-theme temp dir is discarded (no orphan), and a
 *     placement failure after the claim rolls the row back.
 */
import { ConflictException, NotFoundException } from '@nestjs/common';
import { ThemesService } from './themes.service';
import { ThemesRepository, ThemeAlreadyInstalledError } from './themes.repository';
import { ThemeIngestService } from './theme-ingest.service';
import type { ThemeManifest } from './theme-manifest';
import type { InstalledTheme } from '../database/schema/installed_themes';

const TENANT = '01900000-0000-7000-8000-0000000000aa';

function manifest(overrides: Partial<ThemeManifest> = {}): ThemeManifest {
  return {
    name: 'aurora',
    displayName: 'Aurora',
    version: '1.2.3',
    compatibleCore: '^1.0.0',
    slots: ['product-page'],
    ...overrides,
  } as ThemeManifest;
}

function makeRow(over: Partial<InstalledTheme> = {}): InstalledTheme {
  return {
    id: 'row-id',
    tenantId: TENANT,
    name: 'aurora',
    version: '1.2.3',
    source: 'upload',
    manifest: manifest(),
    settings: {},
    templates: {},
    isActive: false,
    installedAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as InstalledTheme;
}

describe('ThemesService (unit)', () => {
  let repo: jest.Mocked<ThemesRepository>;
  let ingest: jest.Mocked<ThemeIngestService>;
  let svc: ThemesService;

  beforeEach(() => {
    repo = {
      insert: jest.fn(),
      findByName: jest.fn().mockResolvedValue(makeRow()),
      findActive: jest.fn().mockResolvedValue(null),
      list: jest.fn(),
      activate: jest.fn().mockResolvedValue(makeRow({ isActive: true })),
      setSettings: jest.fn(),
      deleteByName: jest.fn().mockResolvedValue(true),
    } as unknown as jest.Mocked<ThemesRepository>;
    ingest = {
      ingest: jest.fn(),
      commitExtraction: jest.fn().mockResolvedValue('/data/themes/aurora'),
      discardExtraction: jest.fn().mockResolvedValue(undefined),
      removeThemeDir: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<ThemeIngestService>;
    svc = new ThemesService(repo, ingest);
  });

  // ── install ────────────────────────────────────────────────────────────────

  describe('install', () => {
    const TMP = '/data/themes/.ingest-abc';

    it('re-verifies, persists source=upload + the manifest + validated templates, returns an INACTIVE view', async () => {
      const m = manifest();
      const tpls = { home: { page: 'home' as const, sections: [{ type: 'hero' }] } };
      ingest.ingest.mockResolvedValue({ manifest: m, extractedDir: TMP, templates: tpls });
      repo.insert.mockResolvedValue(makeRow());
      const view = await svc.install(TENANT, Buffer.from('tgz'));
      expect(ingest.ingest).toHaveBeenCalledWith(expect.any(Buffer), { mode: 'install' });
      const arg = repo.insert.mock.calls[0]![0];
      expect(arg.tenantId).toBe(TENANT);
      expect(arg.name).toBe('aurora');
      expect(arg.version).toBe('1.2.3');
      expect(arg.source).toBe('upload');
      expect(arg.manifest).toBe(m);
      // The validated templates from ingest are threaded straight into the persisted row.
      expect(arg.templates).toBe(tpls);
      expect(view.isActive).toBe(false);
      expect(view.slots).toEqual(['product-page']);
    });

    it('claims the DB row BEFORE placing files (insert precedes commitExtraction)', async () => {
      const order: string[] = [];
      ingest.ingest.mockResolvedValue({ manifest: manifest(), extractedDir: TMP, templates: {} });
      repo.insert.mockImplementation(async () => {
        order.push('insert');
        return makeRow();
      });
      ingest.commitExtraction.mockImplementation(async () => {
        order.push('commit');
        return '/data/themes/aurora';
      });
      await svc.install(TENANT, Buffer.from('tgz'));
      expect(order).toEqual(['insert', 'commit']);
      expect(ingest.commitExtraction).toHaveBeenCalledWith(TMP, 'aurora');
    });

    it('maps a (tenant,name) conflict to a 409 and NEVER places files', async () => {
      ingest.ingest.mockResolvedValue({ manifest: manifest(), extractedDir: TMP, templates: {} });
      repo.insert.mockRejectedValue(new ThemeAlreadyInstalledError('aurora'));
      await expect(svc.install(TENANT, Buffer.from('tgz'))).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(ingest.commitExtraction).not.toHaveBeenCalled();
      expect(ingest.discardExtraction).toHaveBeenCalledWith(TMP);
    });

    it('discards the temp extraction on ANY OTHER persistence error, then rethrows', async () => {
      ingest.ingest.mockResolvedValue({ manifest: manifest(), extractedDir: TMP, templates: {} });
      repo.insert.mockRejectedValue(new Error('db down'));
      await expect(svc.install(TENANT, Buffer.from('tgz'))).rejects.toThrow('db down');
      expect(ingest.discardExtraction).toHaveBeenCalledWith(TMP);
      expect(ingest.commitExtraction).not.toHaveBeenCalled();
    });

    it('rolls the row back if placement fails AFTER the claim', async () => {
      ingest.ingest.mockResolvedValue({ manifest: manifest(), extractedDir: TMP, templates: {} });
      repo.insert.mockResolvedValue(makeRow());
      ingest.commitExtraction.mockRejectedValue(new Error('rename failed'));
      await expect(svc.install(TENANT, Buffer.from('tgz'))).rejects.toThrow('rename failed');
      expect(repo.deleteByName).toHaveBeenCalledWith(TENANT, 'aurora');
      expect(ingest.discardExtraction).toHaveBeenCalledWith(TMP);
    });

    it('never leaks the extracted dir path on the returned view', async () => {
      ingest.ingest.mockResolvedValue({ manifest: manifest(), extractedDir: TMP, templates: {} });
      repo.insert.mockResolvedValue(makeRow());
      const view = await svc.install(TENANT, Buffer.from('tgz'));
      expect(JSON.stringify(view)).not.toContain('/data/themes');
    });
  });

  // ── activate ─────────────────────────────────────────────────────────────────

  describe('activate', () => {
    it('returns the activated view', async () => {
      const view = await svc.activate(TENANT, 'aurora');
      expect(repo.activate).toHaveBeenCalledWith(TENANT, 'aurora');
      expect(view.isActive).toBe(true);
    });

    it('404s when the theme is not installed', async () => {
      repo.activate.mockResolvedValue(null);
      await expect(svc.activate(TENANT, 'ghost')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ── settings ─────────────────────────────────────────────────────────────────

  describe('setSettings', () => {
    it('replaces the settings and returns the updated view', async () => {
      repo.setSettings.mockResolvedValue(makeRow({ settings: { primary: '#000' } }));
      const view = await svc.setSettings(TENANT, 'aurora', { primary: '#000' });
      expect(repo.setSettings).toHaveBeenCalledWith(TENANT, 'aurora', { primary: '#000' });
      expect(view.settings).toEqual({ primary: '#000' });
    });

    it('404s when the theme is not installed', async () => {
      repo.setSettings.mockResolvedValue(null);
      await expect(svc.setSettings(TENANT, 'ghost', {})).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ── uninstall ────────────────────────────────────────────────────────────────

  describe('uninstall', () => {
    it('deletes the row and removes the per-theme dir', async () => {
      await svc.uninstall(TENANT, 'aurora');
      expect(repo.deleteByName).toHaveBeenCalledWith(TENANT, 'aurora');
      expect(ingest.removeThemeDir).toHaveBeenCalledWith('aurora');
    });

    it('404s when the theme is not installed and does NOT touch the filesystem', async () => {
      repo.deleteByName.mockResolvedValue(false);
      await expect(svc.uninstall(TENANT, 'ghost')).rejects.toBeInstanceOf(NotFoundException);
      expect(ingest.removeThemeDir).not.toHaveBeenCalled();
    });
  });

  // ── getActive (store surface) ─────────────────────────────────────────────────

  describe('getActive', () => {
    it('returns the active theme name + version + settings (no templates ⇒ field omitted)', async () => {
      repo.findActive.mockResolvedValue(makeRow({ isActive: true, settings: { logo: '/x.png' } }));
      const out = await svc.getActive(TENANT);
      expect(out).toEqual({ name: 'aurora', version: '1.2.3', settings: { logo: '/x.png' } });
      expect(out).not.toHaveProperty('templates'); // additive: omitted when the theme ships none
    });

    it('projects the validated wire templates when the active theme ships some', async () => {
      const tpls = {
        home: { page: 'home' as const, sections: [{ type: 'hero' }] },
        product: { page: 'product' as const, sections: [] },
      };
      repo.findActive.mockResolvedValue(makeRow({ isActive: true, templates: tpls }));
      const out = await svc.getActive(TENANT);
      expect(out?.templates).toEqual(tpls);
    });

    it('omits templates when the stored value is an empty object', async () => {
      repo.findActive.mockResolvedValue(makeRow({ isActive: true, templates: {} }));
      const out = await svc.getActive(TENANT);
      expect(out).not.toHaveProperty('templates');
    });

    it('DROPS templates (degrades) when the stored payload exceeds the aggregate cap', async () => {
      // A row mutated out-of-band to a giant templates blob must NOT be served — the guard omits it.
      const huge = {
        home: {
          page: 'home',
          sections: [{ type: 'hero', settings: { n: 'z'.repeat(7 * 64 * 1024) } }],
        },
      };
      repo.findActive.mockResolvedValue(
        makeRow({ isActive: true, templates: huge as unknown as Record<string, unknown> }),
      );
      const out = await svc.getActive(TENANT);
      expect(out).not.toHaveProperty('templates');
      expect(out?.name).toBe('aurora'); // still serves name/version/settings
    });

    it('DROPS templates when the stored value is not an object (corrupt row degrades, never throws)', async () => {
      repo.findActive.mockResolvedValue(
        makeRow({ isActive: true, templates: 'corrupt' as unknown as Record<string, unknown> }),
      );
      const out = await svc.getActive(TENANT);
      expect(out).not.toHaveProperty('templates');
    });

    it('returns null when no theme is active', async () => {
      repo.findActive.mockResolvedValue(null);
      expect(await svc.getActive(TENANT)).toBeNull();
    });
  });
});
