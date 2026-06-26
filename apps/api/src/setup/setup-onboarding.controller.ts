/**
 * SetupOnboardingController.
 *
 * The NON-secret setup-step endpoints under `/setup/v1`: tax/compliance/brand config +
 * the themes list/activate + the bundled-modules list/install. Every route carries BOTH
 * `@Public()` (so the global fail-closed JwtAuthGuard/PermissionsGuard SKIP it — there is no
 * admin JWT during setup) AND `@UseGuards(SetupTokenGuard)` (the POSITIVE gate: a live
 * `X-Setup-Token` on a not-installed system, else 404). Same combination as SetupConfigController.
 *
 * Zod DTOs validate every body. All writes scope to `getDefaultTenantId()` (server-side, never
 * client input). The themes endpoints list/activate the tenant's `installed_themes` via the shared
 * ThemesService. The modules endpoints list the platform's BUILT-IN modules and install+enable the
 * selected ones — ONLY ids on the BUNDLED_MODULES allowlist are installable (validated server-side
 * before any FS/ingest); arbitrary tarball upload is admin-only.
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Express } from 'express';
import { Public } from '../auth/decorators/public.decorator';
import { SetupTokenGuard } from './guards/setup-token.guard';
import { SetupStateService } from './setup-state.service';
import { SetupOnboardingService, type TaxConfigureResult } from './setup-onboarding.service';
import { TaxConfigureDto } from './dto/tax.dto';
import { ComplianceConfigureDto } from './dto/compliance.dto';
import { BrandConfigureDto } from './dto/brand.dto';
import { ThemeActivateDto, ModulesInstallDto } from './dto/themes-modules.dto';

@Controller('setup/v1')
export class SetupOnboardingController {
  constructor(
    private readonly state: SetupStateService,
    private readonly onboarding: SetupOnboardingService,
  ) {}

  // ─── tax/configure ────────────────────────────────────────────────────────────

  @Public()
  @UseGuards(SetupTokenGuard)
  @Post('tax/configure')
  @HttpCode(200)
  async taxConfigure(@Body() dto: TaxConfigureDto): Promise<TaxConfigureResult & { ok: true }> {
    const tenantId = await this.state.getDefaultTenantId();
    const result = await this.onboarding.configureTax(tenantId, dto);
    return { ok: true, ...result };
  }

  // ─── compliance/configure ──────────────────────────────────────────────────────

  @Public()
  @UseGuards(SetupTokenGuard)
  @Post('compliance/configure')
  @HttpCode(200)
  async complianceConfigure(@Body() dto: ComplianceConfigureDto): Promise<{ ok: true }> {
    const tenantId = await this.state.getDefaultTenantId();
    await this.onboarding.configureCompliance(tenantId, dto);
    return { ok: true };
  }

  // ─── brand (multipart logo upload) ─────────────────────────────────────────────

  @Public()
  @UseGuards(SetupTokenGuard)
  @Post('brand')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('logo', { limits: { fileSize: 5 * 1024 * 1024 } }))
  async brand(
    @Body() dto: BrandConfigureDto,
    @UploadedFile() logo: Express.Multer.File | undefined,
  ): Promise<{ ok: true; logoKey: string | null }> {
    const tenantId = await this.state.getDefaultTenantId();
    const { logoKey } = await this.onboarding.configureBrand(tenantId, dto, logo);
    return { ok: true, logoKey };
  }

  // ─── themes (REAL — lists/activates installed_themes via ThemesService) ────────

  @Public()
  @UseGuards(SetupTokenGuard)
  @Get('themes')
  async themes(): Promise<Awaited<ReturnType<SetupOnboardingService['listThemes']>>> {
    const tenantId = await this.state.getDefaultTenantId();
    return this.onboarding.listThemes(tenantId);
  }

  @Public()
  @UseGuards(SetupTokenGuard)
  @Post('themes/activate')
  @HttpCode(200)
  async activateTheme(@Body() dto: ThemeActivateDto): Promise<{ ok: true }> {
    // Activates the named installed theme (flips is_active); 404 if not installed.
    const tenantId = await this.state.getDefaultTenantId();
    await this.onboarding.activateTheme(tenantId, dto.themeId);
    return { ok: true };
  }

  // ─── modules (REAL — lists/installs the platform's BUILT-IN modules) ───────────

  @Public()
  @UseGuards(SetupTokenGuard)
  @Get('modules')
  async modules(): Promise<Awaited<ReturnType<SetupOnboardingService['listModules']>>> {
    // The platform's bundled module catalog + an `installed` flag for the default tenant.
    const tenantId = await this.state.getDefaultTenantId();
    return this.onboarding.listModules(tenantId);
  }

  @Public()
  @UseGuards(SetupTokenGuard)
  @Post('modules/install')
  @HttpCode(200)
  async installModules(
    @Body() dto: ModulesInstallDto,
  ): Promise<{ ok: true; installed: string[]; failed: string[] }> {
    // Allowlist-validated (BUNDLED_MODULES) install + enable for the default tenant. Idempotent;
    // per-module fault isolation. An unknown / traversing id → 400 (in the service, before any FS).
    // `failed[]` (ids only) surfaces partial/total failure so the wizard never claims false success.
    const tenantId = await this.state.getDefaultTenantId();
    const { installed, failed } = await this.onboarding.installModules(tenantId, dto.moduleIds);
    return { ok: true, installed, failed };
  }
}
