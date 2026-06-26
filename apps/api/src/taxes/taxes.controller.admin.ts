/**
 * Admin Taxes Controller. Routes: /admin/v1/taxes.
 *
 * Permission-gated with the EXISTING `settings:read` / `settings:write` perms (tax
 * config is store-wide owner/admin settings — same precedent as discounts; NOT a new
 * permission). Two surfaces:
 *   - GET/PUT  /admin/v1/taxes/settings   → the tax regime + display/oss settings.
 *   - CRUD     /admin/v1/taxes/rates      → the tax_rates table (eu_vat rate data).
 *
 * EU GUARDRAIL (enforced at the WRITE layer, NOT the engine): an EU VAT-registered
 * merchant must not silently run `tax_mode='none'`. If the request would leave the
 * tenant with an EU-27 `originCountry` AND `tax_mode='none'`, reject with 422. Non-EU
 * origin → `none` is allowed freely. The effective origin is the patched value if
 * present, else the current setting.
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../authorization/decorators/require-permission.decorator';
import { PERMISSIONS } from '../authorization/permissions.constants';
import { Audit } from '../audit/decorators/audit.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { TenantSettingsService } from './tenant-settings.service';
import { TaxesRepository } from './taxes.repository';
import { OssExportService } from './oss-export.service';
import { enforceEuGuardrail } from './eu-guardrail';
import { CreateTaxRateDto, UpdateTaxRateDto, UpdateTaxSettingsDto } from './dto/tax-settings.dto';
import { OssExportQueryDto } from './dto/oss-export.dto';

@ApiTags('Admin / Taxes')
@Controller('admin/v1/taxes')
export class TaxesAdminController {
  constructor(
    private readonly settings: TenantSettingsService,
    private readonly rates: TaxesRepository,
    private readonly oss: OssExportService,
  ) {}

  // ── OSS CSV export ────────────────────────────────────────────────────────────

  @Get('oss-export')
  @RequirePermission(PERMISSIONS.SETTINGS_READ)
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="oss-export.csv"')
  @ApiOperation({ summary: 'OSS CSV: cross-border B2C sales in [from,to] (eu_vat only)' })
  ossExport(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: OssExportQueryDto,
  ): Promise<string> {
    // Parse the ISO strings to a window. A date-only `to` (no time) covers the WHOLE
    // day so the closing bound is inclusive of sales placed any time that date.
    const from = new Date(query.from);
    const to = isDateOnly(query.to) ? endOfDay(query.to) : new Date(query.to);
    return this.oss.buildCsv(user.tenantId, from, to);
  }

  // ── Tax settings ────────────────────────────────────────────────────────────

  @Get('settings')
  @RequirePermission(PERMISSIONS.SETTINGS_READ)
  @ApiOperation({ summary: 'Get the tenant tax settings (regime, display, OSS posture)' })
  getSettings(@CurrentUser() user: AuthenticatedUser) {
    return this.settings.getTaxSettings(user.tenantId);
  }

  @Put('settings')
  @RequirePermission(PERMISSIONS.SETTINGS_WRITE)
  @Audit('tax.settings.updated')
  @ApiOperation({ summary: 'Update the tenant tax settings (EU guardrail enforced)' })
  async updateSettings(@CurrentUser() user: AuthenticatedUser, @Body() dto: UpdateTaxSettingsDto) {
    const current = await this.settings.getTaxSettings(user.tenantId);

    // The effective post-update state for the guardrail check.
    const effectiveMode = dto.taxMode ?? current.taxMode;
    const effectiveOrigin =
      dto.euVatRegistration?.originCountry !== undefined
        ? dto.euVatRegistration.originCountry
        : current.euVatRegistration.originCountry;

    // EU GUARDRAIL (shared rule — ALSO enforced by the setup wizard's tax/configure,
    // via the same `enforceEuGuardrail`, so the two surfaces can never diverge). It
    // checks the CURRENT origin too so "clear originCountry + set none" in one request
    // can't bypass it, and requires an origin for eu_vat.
    enforceEuGuardrail(effectiveMode, effectiveOrigin, current.euVatRegistration.originCountry);

    return this.settings.updateTaxSettings(user.tenantId, {
      taxMode: dto.taxMode,
      pricesIncludeTax: dto.pricesIncludeTax,
      ossPosture: dto.ossPosture,
      euVatRegistration: dto.euVatRegistration,
    });
  }

  // ── Tax rates CRUD ──────────────────────────────────────────────────────────

  @Get('rates')
  @RequirePermission(PERMISSIONS.SETTINGS_READ)
  @ApiOperation({ summary: 'List tax rates' })
  listRates(@CurrentUser() user: AuthenticatedUser) {
    return this.rates.list(user.tenantId);
  }

  @Post('rates')
  @RequirePermission(PERMISSIONS.SETTINGS_WRITE)
  @Audit('tax.rate.created')
  @ApiOperation({ summary: 'Create a tax rate (country, optional region, rate, name)' })
  createRate(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateTaxRateDto) {
    return this.rates.create(user.tenantId, {
      country: dto.country,
      region: dto.region ?? null,
      rate: dto.rate,
      name: dto.name,
    });
  }

  @Put('rates/:id')
  @RequirePermission(PERMISSIONS.SETTINGS_WRITE)
  @Audit('tax.rate.updated')
  @ApiOperation({ summary: 'Update a tax rate' })
  async updateRate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateTaxRateDto,
  ) {
    const row = await this.rates.update(user.tenantId, id, {
      country: dto.country,
      region: dto.region,
      rate: dto.rate,
      name: dto.name,
    });
    if (!row) throw new NotFoundException(`Tax rate ${id} not found`);
    return row;
  }

  @Delete('rates/:id')
  @HttpCode(204)
  @RequirePermission(PERMISSIONS.SETTINGS_WRITE)
  @Audit('tax.rate.deleted')
  @ApiOperation({ summary: 'Delete a tax rate' })
  async deleteRate(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string): Promise<void> {
    const ok = await this.rates.delete(user.tenantId, id);
    if (!ok) throw new NotFoundException(`Tax rate ${id} not found`);
  }
}

/** True when `s` is a bare `YYYY-MM-DD` (no time component). */
function isDateOnly(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s.trim());
}

/** The end-of-day instant (23:59:59.999 UTC) for a `YYYY-MM-DD` so `to` is inclusive. */
function endOfDay(dateOnly: string): Date {
  return new Date(`${dateOnly.trim()}T23:59:59.999Z`);
}
