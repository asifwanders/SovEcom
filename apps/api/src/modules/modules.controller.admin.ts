/**
 * Admin Modules controller. Routes: /admin/v1/modules.
 *
 * RBAC-gated with the `modules:read` / `modules:write` permissions (owner+admin
 * only; staff is fail-closed). Mutating routes are `@Audit`-tagged. The `inspect`/`install`
 * routes take a MULTIPART `.tgz` upload (FileInterceptor, capped at the ingest's 8 MiB
 * compressed limit). `install` ALSO accepts a `grantedPermissions` form field (a JSON
 * string-array) — the ONLY client-supplied trust input; it is intersected server-side with
 * the re-verified manifest (default-deny, in the service).
 *
 * Ingest/verification failures (bad tarball, invalid/incompatible manifest) surface as
 * thrown errors; this controller maps them to 422 (Unprocessable Entity) so the admin UI
 * gets a clean, actionable code rather than a 500.
 *
 * adds `POST …/:name/enable` and `POST …/:name/disable`.
 * These FIXED sub-paths are declared BEFORE the proxy catch-all in the module's controller
 * array (ModulesAdminController first in modules.module.ts) — NestJS matches fixed routes
 * before parameterised ones in the same controller.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UnprocessableEntityException,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Express } from 'express';
import { ApiOperation, ApiQuery, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../authorization/decorators/require-permission.decorator';
import { PERMISSIONS } from '../authorization/permissions.constants';
import { Audit } from '../audit/decorators/audit.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import {
  ModulesService,
  type ModuleInspectResult,
  type InstalledModuleView,
} from './modules.service';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { DEFAULT_INGEST_LIMITS } from './module-ingest.service';
import { parseGrantedPermissions } from './dto/install-module.dto';
import { ModuleRuntimeService } from './runtime/module-runtime.service';

/** Multipart upload cap — match the ingest's compressed-byte ceiling (defence in depth). */
const UPLOAD_LIMITS = { limits: { fileSize: DEFAULT_INGEST_LIMITS.maxCompressedBytes, files: 1 } };

@ApiTags('Admin / Modules')
@Controller('admin/v1/modules')
export class ModulesAdminController {
  constructor(
    private readonly modules: ModulesService,
    private readonly runtime: ModuleRuntimeService,
  ) {}

  @Post('inspect')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.MODULES_WRITE)
  @Audit('module.inspected')
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Inspect a module tarball (verify + semver gate; no persist)' })
  @UseInterceptors(FileInterceptor('file', UPLOAD_LIMITS))
  async inspect(
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<ModuleInspectResult> {
    const buffer = ModulesAdminController.requireTarball(file);
    return this.runIngest(() => this.modules.inspect(buffer));
  }

  @Post('install')
  @HttpCode(201)
  @RequirePermission(PERMISSIONS.MODULES_WRITE)
  @Audit('module.installed')
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Install a module from a tarball with an approved permission grant' })
  @UseInterceptors(FileInterceptor('file', UPLOAD_LIMITS))
  async install(
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile() file: Express.Multer.File | undefined,
    // multipart form field carrying a JSON string-array; parsed + validated below.
    @Body() body: { grantedPermissions?: unknown } = {},
  ): Promise<InstalledModuleView> {
    const buffer = ModulesAdminController.requireTarball(file);
    const granted = parseGrantedPermissions(body?.grantedPermissions);
    return this.runIngest(() => this.modules.install(user.tenantId, buffer, granted));
  }

  @Get()
  @RequirePermission(PERMISSIONS.MODULES_READ)
  @ApiOperation({ summary: 'List installed modules' })
  list(@CurrentUser() user: AuthenticatedUser): Promise<InstalledModuleView[]> {
    return this.modules.list(user.tenantId);
  }

  /**
   * Enable a module: start its sandboxed worker, wire the broker, persist `enabled=true`.
   * 404 if the module is not installed for this tenant. Declared BEFORE the proxy catch-all
   * (`/admin/v1/modules/:name/*path` in ModulesProxyController) — NestJS honours the
   * controller registration order in modules.module.ts (ModulesAdminController first).
   */
  @Post(':name/enable')
  @HttpCode(204)
  @RequirePermission(PERMISSIONS.MODULES_WRITE)
  @Audit('module.enabled')
  @ApiOperation({ summary: 'Enable a module (start its sandboxed worker)' })
  async enable(@CurrentUser() user: AuthenticatedUser, @Param('name') name: string): Promise<void> {
    await this.runtime.enable(user.tenantId, name);
  }

  /**
   * Disable a module: stop its worker, close its DB connection, persist `enabled=false`.
   * No-op if the module is not currently running (204 in all cases — the intent is satisfied).
   */
  @Post(':name/disable')
  @HttpCode(204)
  @RequirePermission(PERMISSIONS.MODULES_WRITE)
  @Audit('module.disabled')
  @ApiOperation({ summary: 'Disable a module (stop its sandboxed worker; preserves data)' })
  async disable(
    @CurrentUser() user: AuthenticatedUser,
    @Param('name') name: string,
  ): Promise<void> {
    await this.runtime.disable(user.tenantId, name);
  }

  @Delete(':name')
  @HttpCode(204)
  @RequirePermission(PERMISSIONS.MODULES_WRITE)
  @Audit('module.uninstalled')
  @ApiOperation({ summary: 'Uninstall a module (removes the row + the fetched dir)' })
  @ApiQuery({
    name: 'dropData',
    required: false,
    type: Boolean,
    description:
      'When true, also drops the module DB schema (mod_<name>) + role. ' +
      'Without this flag the schema/data is preserved (orphaned but recoverable) — no silent data loss.',
  })
  async uninstall(
    @CurrentUser() user: AuthenticatedUser,
    @Param('name') name: string,
    @Query('dropData') dropDataStr?: string,
  ): Promise<void> {
    // HTTP query params arrive as strings; coerce the canonical 'true' value only.
    const dropData = dropDataStr === 'true';
    await this.modules.uninstall(user.tenantId, name, dropData);
  }

  /** Require a non-empty uploaded `.tgz` — a missing file is a 400, not a 500. */
  private static requireTarball(file: Express.Multer.File | undefined): Buffer {
    if (!file || !file.buffer || file.buffer.length === 0) {
      throw new BadRequestException('a module tarball file is required (multipart field "file")');
    }
    return file.buffer;
  }

  /**
   * Run an ingest-backed action, mapping a verification/ingest failure to 422 while letting
   * the HTTP-shaped exceptions the service raises (409 conflict, 404) propagate unchanged.
   */
  private async runIngest<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ConflictException || err instanceof NotFoundException) throw err;
      const message = err instanceof Error ? err.message : 'module verification failed';
      throw new UnprocessableEntityException(message);
    }
  }
}
