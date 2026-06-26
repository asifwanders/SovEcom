/**
 * Admin Shipping Controller. Routes: /admin/v1/shipping.
 *
 * Permission-gated with the existing `settings:read` / `settings:write` perms (shipping
 * config is store-wide settings — same precedent as taxes). Two surfaces:
 *   - CRUD /admin/v1/shipping/zones  → named country groups.
 *   - CRUD /admin/v1/shipping/rates  → rates within a zone (flat / free_over / weight_based).
 *
 * A rate's `zoneId` is validated to belong to THIS tenant before write (a friendlier 422
 * than letting the composite FK reject it).
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Put,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../authorization/decorators/require-permission.decorator';
import { PERMISSIONS } from '../authorization/permissions.constants';
import { Audit } from '../audit/decorators/audit.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { ShippingRepository } from './shipping.repository';
import type { ShippingRate } from '../database/schema/shipping_rates';
import { CreateZoneDto, UpdateZoneDto, CreateRateDto, UpdateRateDto } from './dto/shipping.dto';

@ApiTags('Admin / Shipping')
@Controller('admin/v1/shipping')
export class ShippingAdminController {
  constructor(private readonly repo: ShippingRepository) {}

  // ── Zones ─────────────────────────────────────────────────────────────────────

  @Get('zones')
  @RequirePermission(PERMISSIONS.SETTINGS_READ)
  @ApiOperation({ summary: 'List shipping zones' })
  listZones(@CurrentUser() user: AuthenticatedUser) {
    return this.repo.listZones(user.tenantId);
  }

  @Post('zones')
  @RequirePermission(PERMISSIONS.SETTINGS_WRITE)
  @Audit('shipping.zone.created')
  @ApiOperation({ summary: 'Create a shipping zone (named country group)' })
  createZone(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateZoneDto) {
    return this.repo.createZone(user.tenantId, { name: dto.name, countries: dto.countries });
  }

  @Put('zones/:id')
  @RequirePermission(PERMISSIONS.SETTINGS_WRITE)
  @Audit('shipping.zone.updated')
  @ApiOperation({ summary: 'Update a shipping zone' })
  async updateZone(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateZoneDto,
  ) {
    const row = await this.repo.updateZone(user.tenantId, id, {
      name: dto.name,
      countries: dto.countries,
    });
    if (!row) throw new NotFoundException(`Shipping zone ${id} not found`);
    return row;
  }

  @Delete('zones/:id')
  @HttpCode(204)
  @RequirePermission(PERMISSIONS.SETTINGS_WRITE)
  @Audit('shipping.zone.deleted')
  @ApiOperation({ summary: 'Delete a shipping zone (cascades its rates)' })
  async deleteZone(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string): Promise<void> {
    const ok = await this.repo.deleteZone(user.tenantId, id);
    if (!ok) throw new NotFoundException(`Shipping zone ${id} not found`);
  }

  // ── Rates ─────────────────────────────────────────────────────────────────────

  @Get('rates')
  @RequirePermission(PERMISSIONS.SETTINGS_READ)
  @ApiOperation({ summary: 'List shipping rates' })
  listRates(@CurrentUser() user: AuthenticatedUser) {
    return this.repo.listRates(user.tenantId);
  }

  @Post('rates')
  @RequirePermission(PERMISSIONS.SETTINGS_WRITE)
  @Audit('shipping.rate.created')
  @ApiOperation({ summary: 'Create a shipping rate in a zone' })
  async createRate(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateRateDto) {
    await this.assertZone(user.tenantId, dto.zoneId);
    return this.repo.createRate(user.tenantId, {
      zoneId: dto.zoneId,
      name: dto.name,
      type: dto.type,
      amount: dto.amount,
      currency: dto.currency,
      freeOverAmount: dto.freeOverAmount ?? null,
      weightMinGrams: dto.weightMinGrams ?? null,
      weightMaxGrams: dto.weightMaxGrams ?? null,
    });
  }

  @Put('rates/:id')
  @RequirePermission(PERMISSIONS.SETTINGS_WRITE)
  @Audit('shipping.rate.updated')
  @ApiOperation({ summary: 'Update a shipping rate (merged-row validation)' })
  async updateRate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateRateDto,
  ) {
    if (dto.zoneId !== undefined) await this.assertZone(user.tenantId, dto.zoneId);

    // PATCH-MERGE VALIDATION: the partial UpdateRateDto can only validate fields PRESENT
    // in the body, so a patch that violates an invariant against the STORED row slips
    // through (e.g. clearing freeOverAmount on a free_over rate, or pushing weight_min
    // above the stored max). Load the existing row, merge the patch, validate the MERGED
    // result. 404 the missing-rate case BEFORE validating so a bad patch on a non-existent
    // rate is still 404.
    const existing = await this.repo.findRate(user.tenantId, id);
    if (!existing) throw new NotFoundException(`Shipping rate ${id} not found`);
    this.assertMergedRateValid(existing, dto);

    const row = await this.repo.updateRate(user.tenantId, id, {
      zoneId: dto.zoneId,
      name: dto.name,
      type: dto.type,
      amount: dto.amount,
      currency: dto.currency,
      freeOverAmount: dto.freeOverAmount,
      weightMinGrams: dto.weightMinGrams,
      weightMaxGrams: dto.weightMaxGrams,
    });
    if (!row) throw new NotFoundException(`Shipping rate ${id} not found`);
    return row;
  }

  @Delete('rates/:id')
  @HttpCode(204)
  @RequirePermission(PERMISSIONS.SETTINGS_WRITE)
  @Audit('shipping.rate.deleted')
  @ApiOperation({ summary: 'Delete a shipping rate' })
  async deleteRate(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string): Promise<void> {
    const ok = await this.repo.deleteRate(user.tenantId, id);
    if (!ok) throw new NotFoundException(`Shipping rate ${id} not found`);
  }

  /** Reject a rate whose parent zone is not in this tenant (friendlier than the FK error). */
  private async assertZone(tenantId: string, zoneId: string): Promise<void> {
    const zone = await this.repo.findZone(tenantId, zoneId);
    if (!zone) throw new UnprocessableEntityException(`Shipping zone ${zoneId} not found`);
  }

  /**
   * Validate the MERGED rate (stored row overlaid with the patch) against the same
   * invariants the create schema enforces (which the partial UpdateRateDto cannot, since
   * its fields are optional):
   *   - a `free_over` rate MUST carry a `freeOverAmount` (else it could never be free),
   *   - when BOTH weight bounds are set, `weightMin ≤ weightMax`.
   * For each field, the effective value is the patch value if PRESENT (an explicit `null`
   * counts as present — it clears the field), else the stored value. Throws 422 on a
   * violation. Mirrors DiscountsService.update's PATCH-merge check.
   */
  private assertMergedRateValid(existing: ShippingRate, dto: UpdateRateDto): void {
    const type = dto.type ?? existing.type;
    const freeOverAmount =
      dto.freeOverAmount !== undefined ? dto.freeOverAmount : existing.freeOverAmount;
    const weightMin =
      dto.weightMinGrams !== undefined ? dto.weightMinGrams : existing.weightMinGrams;
    const weightMax =
      dto.weightMaxGrams !== undefined ? dto.weightMaxGrams : existing.weightMaxGrams;

    if (type === 'free_over' && (freeOverAmount === undefined || freeOverAmount === null)) {
      throw new UnprocessableEntityException("type 'free_over' requires freeOverAmount");
    }
    if (weightMin != null && weightMax != null && weightMin > weightMax) {
      throw new UnprocessableEntityException('weightMinGrams must be ≤ weightMaxGrams');
    }
  }
}
