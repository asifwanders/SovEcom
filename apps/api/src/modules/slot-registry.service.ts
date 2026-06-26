/**
 * SlotRegistryService.
 *
 * DERIVES the slot → component map from the tenant's ENABLED modules' declared slot targets.
 * Slots are pure declarative METADATA — no code runs here; this service only reads
 * `installed_modules WHERE enabled` + the admin's `module_slot_resolutions` and computes which
 * module fills each slot. Tenant-scoped: every repo call carries the caller's `tenantId`.
 *
 * Resolution rule (the admin chooses, there is NEVER a silent priority override):
 *   - EXACTLY ONE enabled module targets a slot  → it wins (resolved).
 *   - MORE THAN ONE targets the slot             → CONFLICT: the slot renders NOTHING until an
 *     admin picks a winner. The pick is honoured ONLY if it names a module that STILL targets
 *     the slot (and is still enabled); a stale resolution is ignored → the slot re-conflicts.
 *
 * `setResolution` validates the chosen module is an enabled candidate for the slot before
 * persisting (404 if not enabled/installed, 422 if enabled but not targeting the slot).
 */
import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { SlotsRepository, type EnabledModuleRow } from './slots.repository';
import type { ModuleSlotEntry } from './module-manifest';
import type { ModuleSlotResolution } from '../database/schema/module_slot_resolutions';

/** A cleanly-resolved slot: exactly which module + component fills it. */
export interface ResolvedSlot {
  readonly slot: string;
  readonly module: string;
  readonly component: string;
}

/** A contested slot: the competing candidates an admin must choose between. */
export interface SlotConflict {
  readonly slot: string;
  readonly candidates: ReadonlyArray<{ module: string; component: string }>;
}

/** A candidate (module + component) targeting a given slot. */
interface SlotCandidate {
  readonly module: string;
  readonly component: string;
}

@Injectable()
export class SlotRegistryService {
  constructor(private readonly repo: SlotsRepository) {}

  /**
   * The full slot state — resolved + conflicts — from ONE `computeState` run. Use this for the
   * admin list view: calling `resolved()` and `conflicts()` separately runs `computeState` TWICE
   * over two independent reads, so under a concurrent enable/disable a slot could appear in both
   * arrays or neither. One read keeps the snapshot internally consistent.
   */
  state(tenantId: string): Promise<{ resolved: ResolvedSlot[]; conflicts: SlotConflict[] }> {
    return this.computeState(tenantId);
  }

  /** Cleanly-resolved slots for the tenant (single candidate, or an admin-picked winner). */
  async resolved(tenantId: string): Promise<ResolvedSlot[]> {
    const { resolved } = await this.computeState(tenantId);
    return resolved;
  }

  /** Contested slots for the tenant (more than one candidate, no honoured admin pick). */
  async conflicts(tenantId: string): Promise<SlotConflict[]> {
    const { conflicts } = await this.computeState(tenantId);
    return conflicts;
  }

  /**
   * Persist the admin's chosen winner for a slot. The module MUST be an enabled candidate that
   * targets the slot — otherwise nothing is written:
   *   - not enabled / not installed → 404 (NotFoundException);
   *   - enabled but does not target this slot → 422 (UnprocessableEntityException).
   *
   * We deliberately do NOT require the slot to be currently CONTESTED. Recording a pick for a
   * slot that has only one (or zero) candidates today is an accepted no-op: `computeState`
   * resolves a single-candidate slot from the candidate itself and never consults the pick, so
   * the row simply stays inert until/unless the slot later becomes contested (a valid
   * pre-resolution). Rejecting non-contested slots would both break that and introduce a
   * TOCTOU race — contested-ness can change between the admin's GET and this PUT.
   * Tenant-scoped throughout.
   */
  async setResolution(tenantId: string, slot: string, moduleName: string): Promise<void> {
    const enabled = await this.repo.listEnabledModules(tenantId);
    const module = enabled.find((m) => m.name === moduleName);
    if (!module) {
      throw new NotFoundException(`module not enabled or not installed: ${moduleName}`);
    }
    const targetsSlot = SlotRegistryService.slotEntriesOf(module.manifest).some(
      (s) => s.slot === slot,
    );
    if (!targetsSlot) {
      throw new UnprocessableEntityException(
        `module "${moduleName}" does not target slot "${slot}"`,
      );
    }
    await this.repo.upsertResolution(tenantId, slot, moduleName);
  }

  /**
   * The single source of truth: read enabled modules + resolutions (tenant-scoped), group
   * candidates by slot, then apply the resolution rule per slot.
   */
  private async computeState(
    tenantId: string,
  ): Promise<{ resolved: ResolvedSlot[]; conflicts: SlotConflict[] }> {
    const [enabled, resolutions] = await Promise.all([
      this.repo.listEnabledModules(tenantId),
      this.repo.listResolutions(tenantId),
    ]);

    const bySlot = SlotRegistryService.groupCandidatesBySlot(enabled);
    const pick = new Map(resolutions.map((r: ModuleSlotResolution) => [r.slot, r.moduleName]));

    const resolved: ResolvedSlot[] = [];
    const conflicts: SlotConflict[] = [];

    for (const [slot, candidates] of bySlot) {
      if (candidates.length === 1) {
        const only = candidates[0]!;
        // Exactly one candidate. It auto-wins UNLESS the admin previously made an explicit pick for
        // this slot naming a DIFFERENT module (e.g. picked Y over X, then disabled Y): honouring the
        // sole survivor X would silently override the admin's rejection of X. In that case re-conflict (render nothing, re-prompt).
        const chosen = pick.get(slot);
        if (chosen && chosen !== only.module) {
          conflicts.push({ slot, candidates });
          continue;
        }
        resolved.push({ slot, module: only.module, component: only.component });
        continue;
      }
      // More than one candidate — only an admin pick naming a STILL-targeting candidate resolves
      // it; otherwise (no pick, or a stale pick) the slot stays a conflict (renders nothing).
      const chosenName = pick.get(slot);
      const winner = chosenName ? candidates.find((c) => c.module === chosenName) : undefined;
      if (winner) {
        resolved.push({ slot, module: winner.module, component: winner.component });
      } else {
        conflicts.push({ slot, candidates });
      }
    }

    return { resolved, conflicts };
  }

  /**
   * Group every enabled module's declared slot targets by slot name. Modules are iterated in
   * the repo's (name-ordered) order, so candidate lists are deterministic.
   */
  private static groupCandidatesBySlot(
    enabled: readonly EnabledModuleRow[],
  ): Map<string, SlotCandidate[]> {
    const bySlot = new Map<string, SlotCandidate[]>();
    for (const m of enabled) {
      for (const entry of SlotRegistryService.slotEntriesOf(m.manifest)) {
        const list = bySlot.get(entry.slot) ?? [];
        list.push({ module: m.name, component: entry.component });
        bySlot.set(entry.slot, list);
      }
    }
    return bySlot;
  }

  /**
   * Defensively extract the WELL-FORMED slot entries from a stored manifest. The manifest JSONB
   * is validated at INSTALL time, but the registry must not trust a row with legacy malformed data
   * (e.g. `slots: string[]` instead of structured entries): any entry that is not
   * `{ slot: string, component: string }` with non-empty values is IGNORED. Fail-closed — a bad
   * entry contributes NO candidate, so the slot renders nothing rather than mis-resolving to an
   * `undefined` key. This ensures upgrade safety across manifest format changes.
   */
  private static slotEntriesOf(manifest: { slots?: unknown }): ModuleSlotEntry[] {
    const raw = manifest.slots;
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (e): e is ModuleSlotEntry =>
        typeof e === 'object' &&
        e !== null &&
        typeof (e as { slot?: unknown }).slot === 'string' &&
        (e as { slot: string }).slot.length > 0 &&
        typeof (e as { component?: unknown }).component === 'string' &&
        (e as { component: string }).component.length > 0,
    );
  }
}
