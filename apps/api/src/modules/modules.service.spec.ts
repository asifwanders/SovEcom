/**
 * ModulesService unit tests (SECURITY-CRITICAL).
 *
 * The repo + ingest service are mocked; these tests pin the SECURITY INVARIANTS of the
 * permission-grant + persistence layer in isolation:
 *   - the granted permissions stored are EXACTLY `grantedPermissions ∩ manifest.permissions`
 *     (default-deny: an undeclared-but-granted perm is dropped; a declared-but-ungranted
 *     perm is NOT stored);
 *   - a `(tenant, name)` conflict surfaced by the repo becomes a 409;
 *   - uninstalling a module that isn't installed is a 404;
 *   - inspect never persists and always cleans up (ingest inspect-mode);
 *   - on a persistence failure the ingested per-module dir is cleaned up (no orphan).
 *
 * Unit tests verify that uninstall(…, true) calls provisioner.deprovision and runtime.disable,
 * while uninstall(…, false) does NOT call deprovision.
 */
import { ConflictException, NotFoundException } from '@nestjs/common';
import { ModulesService } from './modules.service';
import { ModulesRepository, ModuleAlreadyInstalledError } from './modules.repository';
import { ModuleIngestService } from './module-ingest.service';
import type { ModuleManifest } from './module-manifest';
import type { InstalledModule } from '../database/schema/installed_modules';
import type { ModuleRuntimeService } from './runtime/module-runtime.service';
import type { ModuleDbProvisioner } from './runtime/module-db.provisioner';

const TENANT = '01900000-0000-7000-8000-0000000000aa';

function manifest(overrides: Partial<ModuleManifest> = {}): ModuleManifest {
  return {
    name: 'wishlist',
    displayName: 'Wishlist',
    version: '1.2.3',
    compatibleCore: '^1.0.0',
    permissions: ['read:products', 'read:categories'],
    slots: [{ slot: 'product-page', component: 'wishlist-button' }],
    ...overrides,
  } as ModuleManifest;
}

function makeRow(over: Partial<InstalledModule> = {}): InstalledModule {
  return {
    id: 'row-id',
    tenantId: TENANT,
    name: 'wishlist',
    version: '1.2.3',
    source: 'upload',
    manifest: manifest(),
    grantedPermissions: ['read:products'],
    settings: {},
    enabled: true,
    installedAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as InstalledModule;
}

describe('ModulesService (unit)', () => {
  let repo: jest.Mocked<ModulesRepository>;
  let ingest: jest.Mocked<ModuleIngestService>;
  let runtime: jest.Mocked<ModuleRuntimeService>;
  let provisioner: jest.Mocked<ModuleDbProvisioner>;
  let svc: ModulesService;

  beforeEach(() => {
    repo = {
      insert: jest.fn(),
      findByName: jest.fn().mockResolvedValue(makeRow()),
      list: jest.fn(),
      deleteByName: jest.fn().mockResolvedValue(true),
      setEnabled: jest.fn().mockResolvedValue(true),
    } as unknown as jest.Mocked<ModulesRepository>;
    ingest = {
      ingest: jest.fn(),
      commitExtraction: jest.fn().mockResolvedValue('/data/modules/wishlist'),
      discardExtraction: jest.fn().mockResolvedValue(undefined),
      removeModuleDir: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<ModuleIngestService>;
    runtime = {
      disable: jest.fn().mockResolvedValue(undefined),
      enable: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<ModuleRuntimeService>;
    provisioner = {
      deprovision: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<ModuleDbProvisioner>;
    svc = new ModulesService(repo, ingest, runtime, provisioner);
  });

  // ── inspect ────────────────────────────────────────────────────────────────

  describe('inspect', () => {
    it('ingests in inspect-mode, never persists, and echoes the requested surface', async () => {
      ingest.ingest.mockResolvedValue({ manifest: manifest(), extractedDir: '/tmp/x' });
      const out = await svc.inspect(Buffer.from('tgz'));
      expect(ingest.ingest).toHaveBeenCalledWith(expect.any(Buffer), { mode: 'inspect' });
      expect(repo.insert).not.toHaveBeenCalled();
      expect(out).toEqual({
        manifest: manifest(),
        requestedPermissions: ['read:products', 'read:categories'],
        requestedSlots: [{ slot: 'product-page', component: 'wishlist-button' }],
        compatible: true,
      });
    });
  });

  // ── install: the default-deny grant intersection ─────────────────────────────

  describe('install — grant intersection (default-deny)', () => {
    it('stores exactly granted ∩ declared, dropping an UNDECLARED granted perm', async () => {
      ingest.ingest.mockResolvedValue({
        manifest: manifest({ permissions: ['read:products', 'read:categories'] }),
        extractedDir: '/data/modules/wishlist',
      });
      repo.insert.mockImplementation(async (input) =>
        makeRow({ grantedPermissions: input.grantedPermissions }),
      );

      // client asks for a declared perm + a NOT-declared one (read:orders).
      const row = await svc.install(TENANT, Buffer.from('tgz'), [
        'read:products',
        'read:orders', // NOT in the manifest → must be dropped
      ]);

      expect(ingest.ingest).toHaveBeenCalledWith(expect.any(Buffer), { mode: 'install' });
      const stored = repo.insert.mock.calls[0]![0].grantedPermissions;
      expect(stored).toEqual(['read:products']); // read:orders dropped, read:categories not granted
      expect(stored).not.toContain('read:orders');
      expect(row.grantedPermissions).toEqual(['read:products']);
    });

    it('does NOT store a declared-but-ungranted permission', async () => {
      ingest.ingest.mockResolvedValue({
        manifest: manifest({ permissions: ['read:products', 'read:categories'] }),
        extractedDir: '/data/modules/wishlist',
      });
      repo.insert.mockImplementation(async (input) =>
        makeRow({ grantedPermissions: input.grantedPermissions }),
      );

      // grant only ONE of the two declared perms.
      await svc.install(TENANT, Buffer.from('tgz'), ['read:products']);
      expect(repo.insert.mock.calls[0]![0].grantedPermissions).toEqual(['read:products']);
    });

    it('an EMPTY grant stores no permissions even when the manifest declares some', async () => {
      ingest.ingest.mockResolvedValue({
        manifest: manifest({ permissions: ['read:products'] }),
        extractedDir: '/data/modules/wishlist',
      });
      repo.insert.mockImplementation(async (input) =>
        makeRow({ grantedPermissions: input.grantedPermissions }),
      );
      await svc.install(TENANT, Buffer.from('tgz'), []);
      expect(repo.insert.mock.calls[0]![0].grantedPermissions).toEqual([]);
    });

    it('de-duplicates a repeated granted permission', async () => {
      ingest.ingest.mockResolvedValue({
        manifest: manifest({ permissions: ['read:products'] }),
        extractedDir: '/data/modules/wishlist',
      });
      repo.insert.mockImplementation(async (input) =>
        makeRow({ grantedPermissions: input.grantedPermissions }),
      );
      await svc.install(TENANT, Buffer.from('tgz'), ['read:products', 'read:products']);
      expect(repo.insert.mock.calls[0]![0].grantedPermissions).toEqual(['read:products']);
    });

    it('persists with source=upload, the re-verified manifest, name + version from it', async () => {
      const m = manifest();
      ingest.ingest.mockResolvedValue({ manifest: m, extractedDir: '/data/modules/wishlist' });
      repo.insert.mockResolvedValue(makeRow());
      await svc.install(TENANT, Buffer.from('tgz'), ['read:products']);
      const arg = repo.insert.mock.calls[0]![0];
      expect(arg.tenantId).toBe(TENANT);
      expect(arg.name).toBe('wishlist'); // from the re-verified manifest, not client input
      expect(arg.version).toBe('1.2.3');
      expect(arg.source).toBe('upload');
      expect(arg.manifest).toBe(m);
      // settings={} + enabled=true are fixed by the repo (NewInstalledModule defaults).
    });

    it('never leaks the extracted dir path on the returned row', async () => {
      ingest.ingest.mockResolvedValue({
        manifest: manifest(),
        extractedDir: '/data/modules/wishlist',
      });
      repo.insert.mockResolvedValue(makeRow());
      const row = await svc.install(TENANT, Buffer.from('tgz'), ['read:products']);
      expect(JSON.stringify(row)).not.toContain('/data/modules');
    });
  });

  // ── install: double-install → 409, no update ─────────────────────────────────

  describe('install — ordering / conflict / cleanup', () => {
    const TMP = '/data/modules/.ingest-abc';

    it('claims the DB row BEFORE placing files (insert precedes commitExtraction)', async () => {
      const order: string[] = [];
      ingest.ingest.mockResolvedValue({ manifest: manifest(), extractedDir: TMP });
      repo.insert.mockImplementation(async () => {
        order.push('insert');
        return makeRow();
      });
      ingest.commitExtraction.mockImplementation(async () => {
        order.push('commit');
        return '/data/modules/wishlist';
      });
      await svc.install(TENANT, Buffer.from('tgz'), ['read:products']);
      expect(order).toEqual(['insert', 'commit']); // claim first, place second
      expect(ingest.commitExtraction).toHaveBeenCalledWith(TMP, 'wishlist');
    });

    it('maps a repo (tenant,name) conflict to a 409 ConflictException (no update)', async () => {
      ingest.ingest.mockResolvedValue({ manifest: manifest(), extractedDir: TMP });
      repo.insert.mockRejectedValue(new ModuleAlreadyInstalledError('wishlist'));
      await expect(
        svc.install(TENANT, Buffer.from('tgz'), ['read:products']),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('on conflict NEVER places files (no commitExtraction) — the existing install is untouched', async () => {
      // The BLOCKER fix: a second install of a different tarball with the same name must not
      // overwrite the already-installed module's on-disk dir. We claim the row first, so a
      // conflict means we never call commitExtraction; we only discard the temp extraction.
      ingest.ingest.mockResolvedValue({ manifest: manifest(), extractedDir: TMP });
      repo.insert.mockRejectedValue(new ModuleAlreadyInstalledError('wishlist'));
      await svc.install(TENANT, Buffer.from('tgz'), ['read:products']).catch(() => undefined);
      expect(ingest.commitExtraction).not.toHaveBeenCalled();
      expect(ingest.removeModuleDir).not.toHaveBeenCalled();
      expect(ingest.discardExtraction).toHaveBeenCalledWith(TMP); // only the temp dir is cleaned
    });

    it('discards the temp extraction on ANY OTHER persistence error, then rethrows', async () => {
      ingest.ingest.mockResolvedValue({ manifest: manifest(), extractedDir: TMP });
      repo.insert.mockRejectedValue(new Error('db down'));
      await expect(svc.install(TENANT, Buffer.from('tgz'), ['read:products'])).rejects.toThrow(
        'db down',
      );
      expect(ingest.discardExtraction).toHaveBeenCalledWith(TMP);
      expect(ingest.commitExtraction).not.toHaveBeenCalled();
    });

    it('rolls the row back if placement fails AFTER the claim (no registry row without files)', async () => {
      ingest.ingest.mockResolvedValue({ manifest: manifest(), extractedDir: TMP });
      repo.insert.mockResolvedValue(makeRow());
      ingest.commitExtraction.mockRejectedValue(new Error('rename failed'));
      await expect(svc.install(TENANT, Buffer.from('tgz'), ['read:products'])).rejects.toThrow(
        'rename failed',
      );
      expect(repo.deleteByName).toHaveBeenCalledWith(TENANT, 'wishlist'); // rollback
      expect(ingest.discardExtraction).toHaveBeenCalledWith(TMP);
    });

    it('a FAILING rollback does not mask the original placement error', async () => {
      // If deleteByName itself throws (e.g. DB blip), the caller must still see the real
      // placement failure, not the rollback error — both cleanups are best-effort.
      ingest.ingest.mockResolvedValue({ manifest: manifest(), extractedDir: TMP });
      repo.insert.mockResolvedValue(makeRow());
      ingest.commitExtraction.mockRejectedValue(new Error('rename failed'));
      repo.deleteByName.mockRejectedValue(new Error('db blip during rollback'));
      await expect(svc.install(TENANT, Buffer.from('tgz'), ['read:products'])).rejects.toThrow(
        'rename failed',
      );
      expect(ingest.discardExtraction).toHaveBeenCalledWith(TMP); // still attempted
    });
  });

  // ── list ─────────────────────────────────────────────────────────────────────

  describe('list', () => {
    it('returns a tenant-scoped, projected view (no manifest blob leak beyond slots)', async () => {
      const m = manifest({
        slots: [
          { slot: 'product-page', component: 'wishlist-button' },
          { slot: 'footer', component: 'wishlist-footer' },
        ],
      });
      repo.list.mockResolvedValue([
        makeRow({ manifest: m, grantedPermissions: ['read:products'] }),
      ]);
      const out = await svc.list(TENANT);
      expect(repo.list).toHaveBeenCalledWith(TENANT);
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({
        name: 'wishlist',
        version: '1.2.3',
        grantedPermissions: ['read:products'],
        slots: [
          { slot: 'product-page', component: 'wishlist-button' },
          { slot: 'footer', component: 'wishlist-footer' },
        ],
        enabled: true,
      });
    });

    it('defaults slots to [] when the manifest declares none', async () => {
      repo.list.mockResolvedValue([makeRow({ manifest: manifest({ slots: undefined }) })]);
      const out = await svc.list(TENANT);
      expect(out[0]!.slots).toEqual([]);
    });
  });

  // ── uninstall ──────────────────────────────────────────────────────────────

  describe('uninstall', () => {
    it('disables the module, deletes the row, and removes the per-module dir', async () => {
      await svc.uninstall(TENANT, 'wishlist');
      expect(runtime.disable).toHaveBeenCalledWith(TENANT, 'wishlist');
      expect(repo.deleteByName).toHaveBeenCalledWith(TENANT, 'wishlist');
      expect(ingest.removeModuleDir).toHaveBeenCalledWith('wishlist');
    });

    it('404s when the module is not installed and does NOT touch the filesystem', async () => {
      repo.findByName.mockResolvedValue(null);
      await expect(svc.uninstall(TENANT, 'ghost')).rejects.toBeInstanceOf(NotFoundException);
      expect(ingest.removeModuleDir).not.toHaveBeenCalled();
      expect(runtime.disable).not.toHaveBeenCalled();
    });

    // ── dropData semantics ────────────────────────────

    it('dropData=true: calls provisioner.deprovision after deleting the row', async () => {
      await svc.uninstall(TENANT, 'wishlist', true);
      expect(runtime.disable).toHaveBeenCalledWith(TENANT, 'wishlist');
      expect(repo.deleteByName).toHaveBeenCalledWith(TENANT, 'wishlist');
      expect(provisioner.deprovision).toHaveBeenCalledWith('wishlist');
    });

    it('dropData=false (default): does NOT call provisioner.deprovision (schema preserved)', async () => {
      await svc.uninstall(TENANT, 'wishlist', false);
      expect(provisioner.deprovision).not.toHaveBeenCalled();
    });

    it('dropData unset defaults to false (schema preserved)', async () => {
      await svc.uninstall(TENANT, 'wishlist');
      expect(provisioner.deprovision).not.toHaveBeenCalled();
    });
  });
});
