/**
 * Store Categories Controller.
 *
 * Routes: /store/v1/categories
 *
 * ALL routes are @Public. Per-IP rate limit 120/min (same as products store).
 * Responses use the StoreCategoryDto allowlist (no tenant_id / timestamps).
 */
import { Controller, Get, HttpException, HttpStatus, Param, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../auth/decorators/public.decorator';
import { RateLimitService } from '../../auth/services/rate-limit.service';
import { StoreTenantService } from '../store-tenant.service';
import { CategoriesService } from './categories.service';
import { STORE_RATE_LIMIT, STORE_RATE_WINDOW_SECONDS } from '../../common/store-rate-limit';

@ApiTags('Store / Categories')
@Public()
@Controller('store/v1/categories')
export class CategoriesStoreController {
  constructor(
    private readonly service: CategoriesService,
    private readonly storeTenant: StoreTenantService,
    private readonly rateLimit: RateLimitService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List categories flat or as tree (?tree=true)' })
  async list(@Req() req: Request, @Query('tree') tree?: string) {
    await this._checkRateLimit(req);
    const tenantId = await this.storeTenant.getDefaultTenantId();
    if (tree === 'true' || tree === '1') {
      const data = await this.service.storeTree(tenantId);
      return { data };
    }
    const data = await this.service.storeFlatList(tenantId);
    return { data };
  }

  @Get('tree')
  @ApiOperation({ summary: 'Get category tree (nested)' })
  async getTree(@Req() req: Request) {
    await this._checkRateLimit(req);
    const tenantId = await this.storeTenant.getDefaultTenantId();
    const data = await this.service.storeTree(tenantId);
    return { data };
  }

  @Get(':slug')
  @ApiOperation({ summary: 'Get category by slug' })
  async findOne(@Req() req: Request, @Param('slug') slug: string) {
    await this._checkRateLimit(req);
    const tenantId = await this.storeTenant.getDefaultTenantId();
    return this.service.storeFindBySlug(tenantId, slug);
  }

  private async _checkRateLimit(req: Request): Promise<void> {
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
