/**
 * Admin Business Identity controller. Routes: /admin/v1/business-identity.
 *
 * Edits the SELLER details printed on INVOICES (legal mentions, SIREN/SIRET, EU-VAT
 * registration). Mirrors the PUT /admin/v1/analytics pattern: GET reads the current
 * value, PUT does a partial read-merge-write through TenantSettingsService.
 *
 * Money/legal-sensitive (this feeds binding invoices), so:
 *  - RBAC-gated with the existing `settings:read` / `settings:write` perms;
 *  - the write is `@Audit`-tagged (`business_identity.updated`);
 *  - the body is validated STRICTLY at the boundary by the Zod DTO (strict schema,
 *    required address parts, 2-letter upper countries, markup-safe printable fields);
 *  - tenant-scoped — every read/write keys off the authenticated user's tenantId.
 *
 * The single PUT body covers BOTH the `business_identity` block (name/siren/address)
 * AND the `eu_vat_registration` block (originCountry/vatNumber), because the admin
 * form edits them together; each lands in its own settings key via the typed seam.
 */
import { Body, Controller, Get, Put } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../authorization/decorators/require-permission.decorator';
import { PERMISSIONS } from '../authorization/permissions.constants';
import { Audit } from '../audit/decorators/audit.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import {
  TenantSettingsService,
  type BusinessIdentity,
  type BusinessIdentityPatch,
  type EuVatRegistration,
} from '../taxes/tenant-settings.service';
import { UpdateBusinessIdentityDto } from './dto/business-identity.dto';

/** The combined identity + EU-VAT view returned by GET/PUT. */
export interface BusinessIdentityView {
  identity: BusinessIdentity;
  euVatRegistration: EuVatRegistration;
}

@ApiTags('Admin / Business identity')
@Controller('admin/v1/business-identity')
export class BusinessIdentityAdminController {
  constructor(private readonly settings: TenantSettingsService) {}

  @Get()
  @RequirePermission(PERMISSIONS.SETTINGS_READ)
  @ApiOperation({
    summary: 'Get the seller business identity + EU-VAT registration (invoice details)',
  })
  async get(@CurrentUser() user: AuthenticatedUser): Promise<BusinessIdentityView> {
    const [identity, euVatRegistration] = await Promise.all([
      this.settings.getBusinessIdentity(user.tenantId),
      this.settings.getEuVatRegistration(user.tenantId),
    ]);
    return { identity, euVatRegistration };
  }

  @Put()
  @RequirePermission(PERMISSIONS.SETTINGS_WRITE)
  @Audit('business_identity.updated')
  @ApiOperation({ summary: 'Update the seller business identity + EU-VAT registration' })
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateBusinessIdentityDto,
  ): Promise<BusinessIdentityView> {
    // Split the validated body into the two typed settings seams.
    const identityPatch: BusinessIdentityPatch = {};
    if (dto.name !== undefined) identityPatch.name = dto.name;
    if (dto.siren !== undefined) identityPatch.siren = dto.siren;
    if (dto.address !== undefined) {
      identityPatch.address =
        dto.address == null
          ? null
          : {
              name: dto.address.name ?? null,
              company: dto.address.company ?? null,
              line1: dto.address.line1,
              line2: dto.address.line2 ?? null,
              city: dto.address.city,
              postalCode: dto.address.postalCode ?? null,
              country: dto.address.country,
            };
    }

    const vatPatch: Partial<EuVatRegistration> = {};
    if (dto.originCountry !== undefined) vatPatch.originCountry = dto.originCountry;
    if (dto.vatNumber !== undefined) vatPatch.vatNumber = dto.vatNumber;

    const identity =
      Object.keys(identityPatch).length > 0
        ? await this.settings.updateBusinessIdentity(user.tenantId, identityPatch)
        : await this.settings.getBusinessIdentity(user.tenantId);

    const euVatRegistration =
      Object.keys(vatPatch).length > 0
        ? await this.settings.updateEuVatRegistration(user.tenantId, vatPatch)
        : await this.settings.getEuVatRegistration(user.tenantId);

    return { identity, euVatRegistration };
  }
}
