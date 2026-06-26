/**
 * Store Tags Controller.
 *
 * Routes: /store/v1/tags
 *
 * ALL routes are @Public. Per-IP rate limit 120/min.
 */
import { Controller, Get, HttpException, HttpStatus, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../auth/decorators/public.decorator';
import { RateLimitService } from '../../auth/services/rate-limit.service';
import { StoreTenantService } from '../store-tenant.service';
import { TagsService } from './tags.service';
import { STORE_RATE_LIMIT, STORE_RATE_WINDOW_SECONDS } from '../../common/store-rate-limit';

@ApiTags('Store / Tags')
@Public()
@Controller('store/v1/tags')
export class TagsStoreController {
  constructor(
    private readonly service: TagsService,
    private readonly storeTenant: StoreTenantService,
    private readonly rateLimit: RateLimitService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List tags (public, no auth)' })
  async list(@Req() req: Request) {
    await this._checkRateLimit(req);
    const tenantId = await this.storeTenant.getDefaultTenantId();
    const data = await this.service.storeList(tenantId);
    return { data };
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
