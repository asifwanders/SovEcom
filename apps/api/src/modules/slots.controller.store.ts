/**
 * Store Slots controller.
 *
 * Route: GET /store/v1/slots — PUBLIC (no auth), default tenant resolved via StoreTenantService.
 * Returns ONLY the cleanly-resolved `slot → { module, component }` map the storefront renders
 * (conflicts/unresolved slots are OMITTED, never silently picked). Per-IP rate limit
 * mirrors the other public store surfaces. NEVER leaks conflicts, manifests, or other tenants.
 */
import { Controller, Get, HttpException, HttpStatus, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import { RateLimitService } from '../auth/services/rate-limit.service';
import { StoreTenantService } from '../catalog/store-tenant.service';
import { SlotRegistryService } from './slot-registry.service';
import { STORE_RATE_LIMIT, STORE_RATE_WINDOW_SECONDS } from '../common/store-rate-limit';

/** The public slot map: `slot → { module, component }` for cleanly-resolved slots only. */
export type StoreSlotMap = Record<string, { module: string; component: string }>;

@ApiTags('Store / Slots')
@Public()
@Controller('store/v1/slots')
export class SlotsStoreController {
  constructor(
    private readonly registry: SlotRegistryService,
    private readonly storeTenant: StoreTenantService,
    private readonly rateLimit: RateLimitService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Get the resolved slot → {module, component} map (public, no auth)' })
  async map(@Req() req: Request): Promise<StoreSlotMap> {
    await this.checkRateLimit(req);
    const tenantId = await this.storeTenant.getDefaultTenantId();
    const resolved = await this.registry.resolved(tenantId);
    const out: StoreSlotMap = {};
    for (const r of resolved) {
      out[r.slot] = { module: r.module, component: r.component };
    }
    return out;
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
