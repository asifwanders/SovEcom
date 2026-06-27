/**
 * Store Home Sections controller.
 *
 * Route: GET /store/v1/storefront/home-sections — PUBLIC (no auth), default tenant resolved via
 * StoreTenantService. Returns the validated marketing section list for the home page. Per-IP rate
 * limit mirrors the other public store surfaces. Corrupt stored entries are silently dropped by
 * the service (defence-in-depth) — the response is always valid; the endpoint never 500s on DB
 * state.
 */
import { Controller, Get, HttpException, HttpStatus, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import { RateLimitService } from '../auth/services/rate-limit.service';
import { StoreTenantService } from '../catalog/store-tenant.service';
import { HomeSectionsService, type HomeSectionsView } from './home-sections.service';
import { STORE_RATE_LIMIT, STORE_RATE_WINDOW_SECONDS } from '../common/store-rate-limit';

@ApiTags('Store / Storefront')
@Public()
@Controller('store/v1/storefront/home-sections')
export class HomeSectionsStoreController {
  constructor(
    private readonly homeSections: HomeSectionsService,
    private readonly storeTenant: StoreTenantService,
    private readonly rateLimit: RateLimitService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Get the home-page marketing sections (public) — validated descriptors only',
  })
  async get(@Req() req: Request): Promise<HomeSectionsView> {
    await this.checkRateLimit(req);
    const tenantId = await this.storeTenant.getDefaultTenantId();
    return this.homeSections.getForStore(tenantId);
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
