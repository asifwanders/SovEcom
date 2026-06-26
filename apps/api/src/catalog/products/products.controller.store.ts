/**
 * Store Products Controller.
 *
 * Routes: /store/v1/products
 *
 * ALL routes are @Public (no auth required). Every response uses the
 * StoreProductDto allowlist. Status='published' filter enforced at query level.
 * Per-IP rate limit: 120 req/min.
 */
import { Controller, Get, HttpException, HttpStatus, Param, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../auth/decorators/public.decorator';
import { ProductsService } from './products.service';
import { RateLimitService } from '../../auth/services/rate-limit.service';
import { StoreTenantService } from '../store-tenant.service';
import { StoreQueryDto } from './dto/store-query.dto';
import { STORE_RATE_LIMIT, STORE_RATE_WINDOW_SECONDS } from '../../common/store-rate-limit';

@ApiTags('Store / Products')
@Public()
@Controller('store/v1/products')
export class ProductsStoreController {
  constructor(
    private readonly service: ProductsService,
    private readonly storeTenant: StoreTenantService,
    private readonly rateLimit: RateLimitService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List published products (cursor pagination, no auth)' })
  async list(@Req() req: Request, @Query() query: StoreQueryDto) {
    await this._checkRateLimit(req);
    const tenantId = await this.storeTenant.getDefaultTenantId();
    return this.service.storeList(tenantId, {
      cursor: query.cursor,
      pageSize: query.pageSize,
    });
  }

  @Get(':slug')
  @ApiOperation({ summary: 'Get a published product by slug (no auth)' })
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
