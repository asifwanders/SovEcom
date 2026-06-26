/**
 * Admin Analytics settings controller. Routes: /admin/v1/analytics.
 *
 * Reads/writes the three storefront analytics ids (Plausible domain, GA4 id, Meta Pixel id) in
 * `tenants.settings.analytics` via the shared TenantSettingsService. RBAC-gated with the existing
 * `settings:read` / `settings:write` perms (same as tax settings); the write is `@Audit`-tagged.
 *
 * The PUT body is sanitised at the boundary to `string | null | undefined` per field: a string sets
 * it, `null`/`''` clears it, anything absent or non-string is left unchanged (never stored). The
 * SERVICE still re-validates every value (allowlist) on the way out — this is defence in depth, not
 * the only gate. RGPD acknowledgement for enabling GA4/Meta is enforced SERVER-SIDE here (not only in
 * the UI): a PUT that SETS a GA4 or Meta id without `rgpdAcknowledged: true` is rejected, so a direct
 * API call can't enable a non-EU tracker without acknowledging the obligations. The `@Audit` event
 * records the acknowledged change (who/when). Clearing an id needs no acknowledgement.
 */
import { BadRequestException, Body, Controller, Get, Put } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../authorization/decorators/require-permission.decorator';
import { PERMISSIONS } from '../authorization/permissions.constants';
import { Audit } from '../audit/decorators/audit.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import {
  TenantSettingsService,
  type AnalyticsSettings,
  type AnalyticsSettingsPatch,
} from '../taxes/tenant-settings.service';

/** Coerce a wire value to the patch field type: string → set, null/'' → clear, else → leave (undefined). */
function patchField(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  return value.trim() === '' ? null : value;
}

@ApiTags('Admin / Analytics')
@Controller('admin/v1/analytics')
export class AnalyticsAdminController {
  constructor(private readonly settings: TenantSettingsService) {}

  @Get()
  @RequirePermission(PERMISSIONS.SETTINGS_READ)
  @ApiOperation({ summary: 'Get storefront analytics config (Plausible / GA4 / Meta ids)' })
  get(@CurrentUser() user: AuthenticatedUser): Promise<AnalyticsSettings> {
    return this.settings.getAnalyticsSettings(user.tenantId);
  }

  @Put()
  @RequirePermission(PERMISSIONS.SETTINGS_WRITE)
  @Audit('analytics.settings_updated')
  @ApiOperation({
    summary: 'Update storefront analytics config (partial; null/empty clears a field)',
  })
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: Record<string, unknown> = {},
  ): Promise<AnalyticsSettings> {
    const patch: AnalyticsSettingsPatch = {};
    const plausibleDomain = patchField(body.plausibleDomain);
    const ga4Id = patchField(body.ga4Id);
    const metaPixelId = patchField(body.metaPixelId);
    if (plausibleDomain !== undefined) patch.plausibleDomain = plausibleDomain;
    if (ga4Id !== undefined) patch.ga4Id = ga4Id;
    if (metaPixelId !== undefined) patch.metaPixelId = metaPixelId;

    // RGPD: ENABLING (setting a non-null value for) GA4 or Meta requires explicit acknowledgement.
    // Clearing (null) or a Plausible-only change does not. Enforced here so a direct API call can't
    // bypass the admin UI's warning gate.
    const enablingTracker = Boolean(patch.ga4Id) || Boolean(patch.metaPixelId);
    if (enablingTracker && body.rgpdAcknowledged !== true) {
      throw new BadRequestException(
        'Enabling Google Analytics or the Meta Pixel requires acknowledging the RGPD implications (rgpdAcknowledged: true).',
      );
    }
    return this.settings.updateAnalyticsSettings(user.tenantId, patch);
  }
}
