/**
 * Admin Themes controller. Routes: /admin/v1/themes.
 *
 * RBAC-gated with `themes:read` / `themes:write` permissions (owner+admin only;
 * staff is fail-closed). Mutating routes are `@Audit`-tagged. The `install` route takes a
 * multipart `.tgz` upload (FileInterceptor, capped at the ingest's 8 MiB compressed limit).
 *
 * Ingest/verification failures (bad tarball, invalid/incompatible manifest) surface as thrown
 * errors; this controller maps them to 422 (Unprocessable Entity) so the admin UI gets a clean,
 * actionable code rather than a 500. The HTTP-shaped exceptions the service raises (409 conflict,
 * 404) propagate unchanged.
 */
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  UnprocessableEntityException,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Express } from 'express';
import { ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../authorization/decorators/require-permission.decorator';
import { PERMISSIONS } from '../authorization/permissions.constants';
import { Audit } from '../audit/decorators/audit.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { ThemesService, type InstalledThemeView } from './themes.service';
import { DEFAULT_THEME_INGEST_LIMITS } from './theme-ingest.service';
import { parseThemeSettings } from './dto/theme-settings.dto';

/** Multipart upload cap — match the ingest's compressed-byte ceiling (defence in depth). */
const UPLOAD_LIMITS = {
  limits: { fileSize: DEFAULT_THEME_INGEST_LIMITS.maxCompressedBytes, files: 1 },
};

@ApiTags('Admin / Themes')
@Controller('admin/v1/themes')
export class ThemesAdminController {
  constructor(private readonly themes: ThemesService) {}

  @Post('install')
  @HttpCode(201)
  @RequirePermission(PERMISSIONS.THEMES_WRITE)
  @Audit('theme.installed')
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Install a theme from a tarball (verify + semver gate; no activate)' })
  @UseInterceptors(FileInterceptor('file', UPLOAD_LIMITS))
  async install(
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<InstalledThemeView> {
    const buffer = ThemesAdminController.requireTarball(file);
    return this.runIngest(() => this.themes.install(user.tenantId, buffer));
  }

  @Get()
  @RequirePermission(PERMISSIONS.THEMES_READ)
  @ApiOperation({ summary: 'List installed themes' })
  list(@CurrentUser() user: AuthenticatedUser): Promise<InstalledThemeView[]> {
    return this.themes.list(user.tenantId);
  }

  @Post(':name/activate')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.THEMES_WRITE)
  @Audit('theme.activated')
  @ApiOperation({ summary: 'Activate a theme (deactivates any previously-active one)' })
  activate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('name') name: string,
  ): Promise<InstalledThemeView> {
    return this.themes.activate(user.tenantId, name);
  }

  @Patch(':name/settings')
  @RequirePermission(PERMISSIONS.THEMES_WRITE)
  @Audit('theme.settings_updated')
  @ApiOperation({ summary: 'Replace a theme’s settings bag (colors/logo/fonts)' })
  setSettings(
    @CurrentUser() user: AuthenticatedUser,
    @Param('name') name: string,
    @Body() body: { settings?: unknown } = {},
  ): Promise<InstalledThemeView> {
    const settings = parseThemeSettings(body?.settings);
    return this.themes.setSettings(user.tenantId, name, settings);
  }

  @Delete(':name')
  @HttpCode(204)
  @RequirePermission(PERMISSIONS.THEMES_WRITE)
  @Audit('theme.uninstalled')
  @ApiOperation({ summary: 'Uninstall a theme (removes the row + the extracted dir)' })
  async uninstall(
    @CurrentUser() user: AuthenticatedUser,
    @Param('name') name: string,
  ): Promise<void> {
    await this.themes.uninstall(user.tenantId, name);
  }

  /** Require a non-empty uploaded `.tgz` — a missing file is a 400, not a 500. */
  private static requireTarball(file: Express.Multer.File | undefined): Buffer {
    if (!file || !file.buffer || file.buffer.length === 0) {
      throw new BadRequestException('a theme tarball file is required (multipart field "file")');
    }
    return file.buffer;
  }

  /**
   * Run an ingest-backed action, mapping a verification/ingest failure to 422 while letting the
   * HTTP-shaped exceptions the service raises (409 conflict, 404) propagate unchanged.
   */
  private async runIngest<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ConflictException || err instanceof NotFoundException) throw err;
      const message = err instanceof Error ? err.message : 'theme verification failed';
      throw new UnprocessableEntityException(message);
    }
  }
}
