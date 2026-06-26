/**
 * AnalyticsModule. Mounts the admin analytics-settings controller.
 *
 * No own providers: the config lives in `tenants.settings.analytics`, read/written through
 * TenantSettingsService which TaxesModule exports. The storefront read path is the store theme
 * controller (ThemesModule) — analytics is served by piggybacking GET /store/v1/theme.
 */
import { Module } from '@nestjs/common';
import { TaxesModule } from '../taxes/taxes.module';
import { AnalyticsAdminController } from './analytics.controller.admin';

@Module({
  imports: [TaxesModule],
  controllers: [AnalyticsAdminController],
})
export class AnalyticsModule {}
