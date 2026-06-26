/**
 * Store Themes controller.
 *
 * Route: GET /store/v1/theme — PUBLIC (no auth), default tenant resolved via StoreTenantService.
 * Returns the active theme's name + version + settings (the storefront reads this to render),
 * or `null` when no theme is active. Per-IP rate limit mirrors the other public store surfaces.
 * NEVER leaks the full manifest, the on-disk path, or any other tenant's theme.
 */
import { Controller, Get, HttpException, HttpStatus, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import { RateLimitService } from '../auth/services/rate-limit.service';
import { StoreTenantService } from '../catalog/store-tenant.service';
import { TenantSettingsService } from '../taxes/tenant-settings.service';
import { ThemesService, type ActiveThemeView } from './themes.service';
import { STORE_RATE_LIMIT, STORE_RATE_WINDOW_SECONDS } from '../common/store-rate-limit';

@ApiTags('Store / Themes')
@Public()
@Controller('store/v1/theme')
export class ThemesStoreController {
  constructor(
    private readonly themes: ThemesService,
    private readonly storeTenant: StoreTenantService,
    private readonly rateLimit: RateLimitService,
    private readonly settings: TenantSettingsService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Get the active theme (public) — name + version + settings + analytics',
  })
  async active(@Req() req: Request): Promise<ActiveThemeView | null> {
    await this.checkRateLimit(req);
    const tenantId = await this.storeTenant.getDefaultTenantId();
    const theme = await this.themes.getActive(tenantId);
    if (!theme) return null;
    // Piggyback analytics config so the storefront's existing theme fetch carries it.
    // Omit the key entirely when nothing is configured — don't advertise analytics state publicly.
    const analytics = await this.settings.getAnalyticsSettings(tenantId);
    const hasAnalytics = analytics.plausibleDomain || analytics.ga4Id || analytics.metaPixelId;
    return hasAnalytics ? { ...theme, analytics } : theme;
  }

  private async checkRateLimit(req: Request): Promise<void> {
    const ip = req.ip ?? 'unknown';
    const result = await this.rateLimit.check(`store:${ip}`, {
      limit: STORE_RATE_LIMIT,
      windowSeconds: STORE_RATE_WINDOW_SECONDS,
    });
    if (!result.allowed) {
      throw new HttpException('Too Many Requests', HttpStatus.TOO_MANY_REQUESTS);
    }
  }
}
