/**
 * ModulesService (SECURITY-CRITICAL: default-deny grant).
 *
 * Orchestrates the inspect / install / list / uninstall flows over the verifiers and
 * the {@link ModuleIngestService}. The headline security properties enforced HERE:
 *
 *   1. NO code execution — install only EXTRACTS + verifies + persists (the ingest service
 *      never runs module code; this service never `require()`s anything).
 *   2. The manifest is RE-VERIFIED on install — the client supplies only the tarball and the
 *      `grantedPermissions` list; the manifest/permissions come from the server's own
 *      re-extraction, never from a round-tripped client payload.
 *   3. DEFAULT-DENY grant: the stored grant is `grantedPermissions ∩ manifest.permissions` —
 *      a granted-but-UNDECLARED permission is dropped; a declared-but-UNGRANTED one is not
 *      stored. So an undeclared permission can NEVER be persisted.
 *   4. Tenant isolation — every persistence call is tenant-scoped via the repo.
 *   5. No orphaned dirs — a failed install removes the extracted per-module dir; uninstall
 *      removes it after deleting the row.
 * 6. Double-install is a 409 (no auto-update / no update endpoint).
 *
 * uninstall accepts `dropData` to DROP the module DB
 * schema + role via {@link ModuleDbProvisioner}. Without the flag, the schema is preserved
 * (orphaned but recoverable) — never silent data loss.
 */
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  ModulesRepository,
  ModuleAlreadyInstalledError,
  type InstallModuleInput,
} from './modules.repository';
import { ModuleIngestService } from './module-ingest.service';
import type { ModuleManifest, ModulePermission, ModuleSlotEntry } from './module-manifest';
import type { InstalledModule } from '../database/schema/installed_modules';
import { ModuleRuntimeService } from './runtime/module-runtime.service';
import { ModuleDbProvisioner } from './runtime/module-db.provisioner';

/** Result of inspecting a tarball — rendered by the admin UI for permission approval. */
export interface ModuleInspectResult {
  readonly manifest: ModuleManifest;
  readonly requestedPermissions: readonly ModulePermission[];
  readonly requestedSlots: readonly ModuleSlotEntry[];
  readonly compatible: true;
}

/** The projected row returned to the admin (manifest blob NOT echoed wholesale). */
export interface InstalledModuleView {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly grantedPermissions: string[];
  readonly slots: ModuleSlotEntry[];
  readonly enabled: boolean;
  readonly installedAt: Date;
}

@Injectable()
export class ModulesService {
  constructor(
    private readonly repo: ModulesRepository,
    private readonly ingest: ModuleIngestService,
    private readonly runtime: ModuleRuntimeService,
    private readonly provisioner: ModuleDbProvisioner,
  ) {}

  /**
   * Inspect a tarball WITHOUT persisting: ingest in inspect-mode (extract → verify → semver
   * gate → CLEAN UP the temp dir), then echo the requested permissions + slots for approval.
   * If the module is incompatible/invalid the ingest throws (the controller maps it to 4xx).
   */
  async inspect(tarball: Buffer): Promise<ModuleInspectResult> {
    const { manifest } = await this.ingest.ingest(tarball, { mode: 'inspect' });
    return {
      manifest,
      requestedPermissions: manifest.permissions,
      requestedSlots: manifest.slots ?? [],
      compatible: true,
    };
  }

  /**
   * Install a module. The ordering is SECURITY-CRITICAL (no overwrite / no
   * auto-update): we must claim the `(tenant, name)` row in the DB BEFORE we place any files
   * on disk, so a second install of a different tarball with an already-installed name can
   * never destroy + replace the existing module's files on its way to a 409.
   *
   *   1. RE-ingest in install-mode (re-extract + re-verify — never trust a round-tripped
   *      manifest). The verified tree stays in an isolated TEMP dir; nothing is placed yet.
   *   2. Compute the DEFAULT-DENY grant `grantedPermissions ∩ manifest.permissions` (de-duped,
   *      manifest order preserved).
   *   3. INSERT the row (the atomic `(tenant, name)` claim). A conflict → discard the temp dir
   *      and 409 — the EXISTING install's files are never touched.
   *   4. Only after the claim succeeds, COMMIT the extraction (place it at `modules/<name>`).
   *      If placement fails, roll the row back so we never register a module with no files.
   */
  async install(
    tenantId: string,
    tarball: Buffer,
    grantedPermissions: string[],
  ): Promise<InstalledModuleView> {
    // 1. Re-extract + re-verify into an isolated temp dir. The manifest used from here on is
    //    the server's own, not the client's. `extractedDir` is NOT yet placed at modules/<name>.
    const { manifest, extractedDir } = await this.ingest.ingest(tarball, { mode: 'install' });

    // 2. DEFAULT-DENY intersection: keep only perms that are BOTH granted by the admin AND
    //    declared in the (re-verified) manifest. De-dup, preserve the manifest's declared order.
    const granted = new Set(grantedPermissions);
    const grantedToStore = [...new Set(manifest.permissions.filter((p) => granted.has(p)))];

    // 3. Claim the (tenant, name) row FIRST. On conflict or any DB error, discard the temp
    //    extraction and NEVER touch an existing install's on-disk dir.
    let row: InstalledModule;
    try {
      const input: InstallModuleInput = {
        tenantId,
        name: manifest.name,
        version: manifest.version,
        source: 'upload',
        manifest,
        grantedPermissions: grantedToStore,
      };
      row = await this.repo.insert(input);
    } catch (err) {
      await this.ingest.discardExtraction(extractedDir);
      if (err instanceof ModuleAlreadyInstalledError) {
        // no auto-update / no silent overwrite. Refuse and leave existing state intact.
        throw new ConflictException('module already installed');
      }
      throw err;
    }

    // 4. Row claimed — place the verified files. If placement fails, roll the row back so the
    //    registry never references a module whose files were never written. Both cleanups are
    //    best-effort and MUST NOT mask the original placement error (a failing rollback can't
    //    be allowed to throw over `err` and leave the caller with a misleading DB-error).
    try {
      await this.ingest.commitExtraction(extractedDir, manifest.name);
    } catch (err) {
      await this.repo.deleteByName(tenantId, manifest.name).catch(() => undefined);
      await this.ingest.discardExtraction(extractedDir).catch(() => undefined);
      throw err;
    }

    return ModulesService.toView(row);
  }

  /** List the tenant's installed modules as a projected view (slots pulled from the manifest). */
  async list(tenantId: string): Promise<InstalledModuleView[]> {
    const rows = await this.repo.list(tenantId);
    return rows.map((r) => ModulesService.toView(r));
  }

  /**
   * Uninstall: stop the worker (if running) + close its DB connection, delete the tenant's
   * row, then remove the per-module dir. 404 if the module is not installed for this tenant.
   *
   * When `dropData` is `true`, also drops the DB schema (`mod_<name>`) and its role via
   * {@link ModuleDbProvisioner.deprovision} — this is IRREVERSIBLE. Without the flag the
   * schema/data is kept (orphaned but recoverable) (no silent data loss).
   *
   * Ordering: disable first (closes the module DB connection so deprovision can terminate
   * backends), then delete the registry row, then remove FS dir, then deprovision.
   */
  async uninstall(tenantId: string, name: string, dropData = false): Promise<void> {
    // 404 check first — loadrow before we touch anything.
    const row = await this.repo.findByName(tenantId, name);
    if (!row) {
      throw new NotFoundException(`module not installed: ${name}`);
    }
    // 1. Stop the worker + close the dedicated DB connection (no-op if not running).
    //    Must happen BEFORE deprovision so the connection pool is drained before we try to
    //    DROP SCHEMA (which terminates backends via pg_terminate_backend).
    await this.runtime.disable(tenantId, name);
    // 2. Delete the registry row and the on-disk module dir (existing behaviour).
    await this.repo.deleteByName(tenantId, name);
    await this.ingest.removeModuleDir(name);
    // 3. Conditionally drop the DB schema + role (admin-confirmed destruction).
    if (dropData) {
      await this.provisioner.deprovision(name);
    }
  }

  /** Project a stored row to the admin view. NEVER leaks the on-disk extraction path. */
  private static toView(row: InstalledModule): InstalledModuleView {
    const manifest = row.manifest as ModuleManifest;
    return {
      id: row.id,
      name: row.name,
      version: row.version,
      grantedPermissions: (row.grantedPermissions as string[]) ?? [],
      slots: manifest?.slots ?? [],
      enabled: row.enabled,
      installedAt: row.installedAt,
    };
  }
}
