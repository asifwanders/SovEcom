/**
 * SlotRegistryService unit tests.
 *
 * The repo is mocked; these pin the RESOLUTION INVARIANTS (admin chooses, NO silent override):
 *   - exactly one enabled module targets a slot → it WINS (resolved);
 *   - more than one → CONFLICT (omitted from `resolved`, listed in `conflicts`);
 *   - an admin resolution naming a STILL-targeting candidate → that module wins (resolved);
 *   - a resolution naming a module that no longer targets/enabled the slot → IGNORED (re-conflict);
 *   - `setResolution` validates the module is enabled + targets the slot (4xx otherwise);
 *   - tenant scoping (the repo is always called with the caller's tenantId).
 */
import { NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { SlotRegistryService } from './slot-registry.service';
import { SlotsRepository, type EnabledModuleRow } from './slots.repository';
import type { ModuleManifest } from './module-manifest';
import type { ModuleSlotResolution } from '../database/schema/module_slot_resolutions';

const TENANT = '01900000-0000-7000-8000-0000000000aa';

function mod(name: string, slots: { slot: string; component: string }[]): EnabledModuleRow {
  return {
    name,
    manifest: {
      name,
      displayName: name,
      version: '1.0.0',
      compatibleCore: '^1.0.0',
      permissions: [],
      slots,
    } as ModuleManifest,
  };
}

function resolution(slot: string, moduleName: string): ModuleSlotResolution {
  return {
    tenantId: TENANT,
    slot,
    moduleName,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('SlotRegistryService (unit)', () => {
  let repo: jest.Mocked<SlotsRepository>;
  let svc: SlotRegistryService;

  beforeEach(() => {
    repo = {
      listEnabledModules: jest.fn(),
      listResolutions: jest.fn().mockResolvedValue([]),
      upsertResolution: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<SlotsRepository>;
    svc = new SlotRegistryService(repo);
  });

  describe('resolved / conflicts', () => {
    it('a single enabled module targeting a slot WINS (resolved, no conflict)', async () => {
      repo.listEnabledModules.mockResolvedValue([
        mod('wishlist', [{ slot: 'product-page', component: 'wishlist-button' }]),
      ]);
      const resolved = await svc.resolved(TENANT);
      const conflicts = await svc.conflicts(TENANT);
      expect(repo.listEnabledModules).toHaveBeenCalledWith(TENANT);
      expect(resolved).toEqual([
        { slot: 'product-page', module: 'wishlist', component: 'wishlist-button' },
      ]);
      expect(conflicts).toEqual([]);
    });

    it('two modules targeting the SAME slot → CONFLICT (omitted from resolved)', async () => {
      repo.listEnabledModules.mockResolvedValue([
        mod('wishlist', [{ slot: 'product-page', component: 'wishlist-button' }]),
        mod('reviews', [{ slot: 'product-page', component: 'reviews-widget' }]),
      ]);
      const resolved = await svc.resolved(TENANT);
      const conflicts = await svc.conflicts(TENANT);
      expect(resolved).toEqual([]);
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]!.slot).toBe('product-page');
      expect(conflicts[0]!.candidates).toEqual(
        expect.arrayContaining([
          { module: 'wishlist', component: 'wishlist-button' },
          { module: 'reviews', component: 'reviews-widget' },
        ]),
      );
    });

    it('an admin resolution naming a STILL-targeting candidate → that module wins', async () => {
      repo.listEnabledModules.mockResolvedValue([
        mod('wishlist', [{ slot: 'product-page', component: 'wishlist-button' }]),
        mod('reviews', [{ slot: 'product-page', component: 'reviews-widget' }]),
      ]);
      repo.listResolutions.mockResolvedValue([resolution('product-page', 'reviews')]);
      const resolved = await svc.resolved(TENANT);
      const conflicts = await svc.conflicts(TENANT);
      expect(resolved).toEqual([
        { slot: 'product-page', module: 'reviews', component: 'reviews-widget' },
      ]);
      expect(conflicts).toEqual([]);
    });

    it('a resolution naming a NO-LONGER-targeting module is IGNORED → re-conflict', async () => {
      repo.listEnabledModules.mockResolvedValue([
        mod('wishlist', [{ slot: 'product-page', component: 'wishlist-button' }]),
        mod('reviews', [{ slot: 'product-page', component: 'reviews-widget' }]),
      ]);
      // 'promo' is not among the candidates (disabled / no longer targeting) → stale.
      repo.listResolutions.mockResolvedValue([resolution('product-page', 'promo')]);
      const resolved = await svc.resolved(TENANT);
      const conflicts = await svc.conflicts(TENANT);
      expect(resolved).toEqual([]);
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]!.slot).toBe('product-page');
    });

    it('a single survivor is NOT auto-resolved when the admin explicitly picked a DIFFERENT module', async () => {
      // Admin picked Y over X, then disabled Y → only X remains. Auto-resolving to X would silently
      // override the admin's rejection of X. Must re-conflict, not resolve.
      repo.listEnabledModules.mockResolvedValue([
        mod('wishlist', [{ slot: 'product-page', component: 'wishlist-button' }]),
      ]);
      repo.listResolutions.mockResolvedValue([resolution('product-page', 'reviews')]); // picked 'reviews', now gone
      const resolved = await svc.resolved(TENANT);
      const conflicts = await svc.conflicts(TENANT);
      expect(resolved).toEqual([]);
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]!.slot).toBe('product-page');
    });

    it('a resolution for a non-contested (single-candidate) slot is harmless', async () => {
      repo.listEnabledModules.mockResolvedValue([
        mod('wishlist', [{ slot: 'product-page', component: 'wishlist-button' }]),
      ]);
      repo.listResolutions.mockResolvedValue([resolution('product-page', 'wishlist')]);
      const resolved = await svc.resolved(TENANT);
      expect(resolved).toEqual([
        { slot: 'product-page', module: 'wishlist', component: 'wishlist-button' },
      ]);
    });

    it('IGNORES a malformed/legacy manifest (e.g. old slots:string[]) — fail-closed, no candidate', async () => {
      // A row predating the 3.3e slot-shape change stores `slots: ['product-page']` (strings, not
      // {slot,component}). The registry must not trust the JSONB cast: such entries contribute NO
      // candidate (the slot renders nothing) rather than mis-resolving to an `undefined` key.
      const legacy: EnabledModuleRow = {
        name: 'legacy',
        manifest: {
          name: 'legacy',
          displayName: 'legacy',
          version: '1.0.0',
          compatibleCore: '^1.0.0',
          permissions: [],
          slots: ['product-page'] as unknown,
        } as unknown as ModuleManifest,
      };
      repo.listEnabledModules.mockResolvedValue([
        legacy,
        mod('wishlist', [{ slot: 'sidebar', component: 'wishlist-button' }]),
      ]);
      const resolved = await svc.resolved(TENANT);
      const conflicts = await svc.conflicts(TENANT);
      // Only the well-formed module's slot resolves; the legacy garbage produces nothing.
      expect(resolved).toEqual([
        { slot: 'sidebar', module: 'wishlist', component: 'wishlist-button' },
      ]);
      expect(conflicts).toEqual([]);
    });

    it('groups distinct slots independently (resolve one, conflict another)', async () => {
      repo.listEnabledModules.mockResolvedValue([
        mod('wishlist', [{ slot: 'sidebar', component: 'wishlist-button' }]),
        mod('reviews', [{ slot: 'footer', component: 'reviews-a' }]),
        mod('ratings', [{ slot: 'footer', component: 'ratings-b' }]),
      ]);
      const resolved = await svc.resolved(TENANT);
      const conflicts = await svc.conflicts(TENANT);
      expect(resolved).toEqual([
        { slot: 'sidebar', module: 'wishlist', component: 'wishlist-button' },
      ]);
      expect(conflicts.map((c) => c.slot)).toEqual(['footer']);
    });
  });

  describe('state (single atomic snapshot)', () => {
    it('returns resolved + conflicts from ONE computeState run (repo read once, not twice)', async () => {
      repo.listEnabledModules.mockResolvedValue([
        mod('wishlist', [{ slot: 'sidebar', component: 'wishlist-button' }]),
        mod('reviews', [{ slot: 'footer', component: 'reviews-a' }]),
        mod('ratings', [{ slot: 'footer', component: 'ratings-b' }]),
      ]);
      const { resolved, conflicts } = await svc.state(TENANT);
      // ONE computeState = ONE read of each repo source (calling resolved()+conflicts() would be 2).
      expect(repo.listEnabledModules).toHaveBeenCalledTimes(1);
      expect(repo.listResolutions).toHaveBeenCalledTimes(1);
      expect(repo.listEnabledModules).toHaveBeenCalledWith(TENANT);
      expect(resolved).toEqual([
        { slot: 'sidebar', module: 'wishlist', component: 'wishlist-button' },
      ]);
      expect(conflicts.map((c) => c.slot)).toEqual(['footer']);
    });
  });

  describe('setResolution', () => {
    it('persists the winner when the module is an enabled candidate for the slot', async () => {
      repo.listEnabledModules.mockResolvedValue([
        mod('wishlist', [{ slot: 'product-page', component: 'wishlist-button' }]),
        mod('reviews', [{ slot: 'product-page', component: 'reviews-widget' }]),
      ]);
      await svc.setResolution(TENANT, 'product-page', 'reviews');
      expect(repo.upsertResolution).toHaveBeenCalledWith(TENANT, 'product-page', 'reviews');
    });

    it('rejects a module that is not enabled / not installed (404)', async () => {
      repo.listEnabledModules.mockResolvedValue([
        mod('wishlist', [{ slot: 'product-page', component: 'wishlist-button' }]),
      ]);
      await expect(svc.setResolution(TENANT, 'product-page', 'ghost')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(repo.upsertResolution).not.toHaveBeenCalled();
    });

    it('rejects a module that is enabled but does NOT target the slot (422)', async () => {
      repo.listEnabledModules.mockResolvedValue([
        mod('wishlist', [{ slot: 'product-page', component: 'wishlist-button' }]),
        mod('reviews', [{ slot: 'footer', component: 'reviews-widget' }]),
      ]);
      await expect(svc.setResolution(TENANT, 'product-page', 'reviews')).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
      expect(repo.upsertResolution).not.toHaveBeenCalled();
    });
  });

  describe('tenant scoping', () => {
    it('reads are always scoped to the caller tenant', async () => {
      repo.listEnabledModules.mockResolvedValue([]);
      await svc.resolved('tenant-b');
      await svc.conflicts('tenant-b');
      expect(repo.listEnabledModules).toHaveBeenCalledWith('tenant-b');
      expect(repo.listResolutions).toHaveBeenCalledWith('tenant-b');
    });
  });
});
