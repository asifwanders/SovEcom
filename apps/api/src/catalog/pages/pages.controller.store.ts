/**
 * Store Pages Controller.
 *
 * Route: GET /store/v1/pages/:slug
 *
 * @Public. Per-IP rate limit 120/min (same store limit as categories/products).
 * Tenant resolved via StoreTenantService default tenant. Returns ONLY the
 * published row for `(tenant, slug, locale)` mapped to the StorePageDto allowlist
 * — never the raw row. 404 on unknown/draft/wrong-locale (no default-locale
 * fallback8).
 *
 * `?locale=` is validated to `fr|en` and DEFAULTS to `en` when absent (3
 * the app default locale is English — we do NOT rely on the DB column default 'fr'
 * for reads). A malformed locale is a 400.
 */
import {
  BadRequestException,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Param,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Public } from '../../auth/decorators/public.decorator';
import { RateLimitService } from '../../auth/services/rate-limit.service';
import { StoreTenantService } from '../store-tenant.service';
import { PagesService } from './pages.service';
import type { StorePageDto } from './dto/store-page.dto';
import { STORE_RATE_LIMIT, STORE_RATE_WINDOW_SECONDS } from '../../common/store-rate-limit';

/** App default read locale = English, NOT the DB column default 'fr'. */
const DEFAULT_LOCALE = 'en';
const localeSchema = z.enum(['fr', 'en']);

@ApiTags('Store / Pages')
@Public()
@Controller('store/v1/pages')
export class PagesStoreController {
  constructor(
    private readonly service: PagesService,
    private readonly storeTenant: StoreTenantService,
    private readonly rateLimit: RateLimitService,
  ) {}

  @Get(':slug')
  @ApiOperation({ summary: 'Get a published content page by slug (?locale=fr|en, default en)' })
  async findOne(
    @Req() req: Request,
    @Param('slug') slug: string,
    @Query('locale') locale?: string,
  ): Promise<StorePageDto> {
    await this._checkRateLimit(req);
    const resolvedLocale = this._resolveLocale(locale);
    const tenantId = await this.storeTenant.getDefaultTenantId();
    return this.service.storeFindBySlug(tenantId, slug, resolvedLocale);
  }

  /** Validate `?locale=`; absent → 'en', invalid → 400. */
  private _resolveLocale(raw: string | undefined): 'fr' | 'en' {
    if (raw === undefined || raw === '') return DEFAULT_LOCALE;
    const parsed = localeSchema.safeParse(raw);
    if (!parsed.success) {
      throw new BadRequestException("Invalid locale. Supported locales are 'fr' and 'en'.");
    }
    return parsed.data;
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
