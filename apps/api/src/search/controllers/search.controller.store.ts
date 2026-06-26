/**
 * Store Search Controller.
 *
 * Route: GET /store/v1/search
 *
 * Public (no JWT required). Rate-limited at 120 req/min per IP (same as other store endpoints).
 * Tenant resolved via StoreTenantService (anonymous store context).
 *
 * All query validation is handled by SearchQueryDto (nestjs-zod); bad params are clamped /
 * defaulted — never a 500 on garbage input.
 */
import { Controller, Get, HttpException, HttpStatus, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../auth/decorators/public.decorator';
import { RateLimitService } from '../../auth/services/rate-limit.service';
import { StoreTenantService } from '../../catalog/store-tenant.service';
import { SearchQueryService } from '../search-query.service';
import { SearchQueryDto } from '../dto/search-query.dto';
import type { SearchResultDto } from '../dto/search-result.dto';
import { STORE_RATE_LIMIT, STORE_RATE_WINDOW_SECONDS } from '../../common/store-rate-limit';

@ApiTags('Store / Search')
@Public()
@Controller('store/v1/search')
export class SearchStoreController {
  constructor(
    private readonly queryService: SearchQueryService,
    private readonly storeTenant: StoreTenantService,
    private readonly rateLimit: RateLimitService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Full-text product search (no auth, rate-limited)' })
  async search(@Req() req: Request, @Query() query: SearchQueryDto): Promise<SearchResultDto> {
    await this._checkRateLimit(req);
    const tenantId = await this.storeTenant.getDefaultTenantId();
    return this.queryService.query(tenantId, query);
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
