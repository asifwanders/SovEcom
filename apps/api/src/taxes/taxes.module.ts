/**
 * TaxesModule.
 *
 * Provides + exports TaxesService (the cart imports this module to resolve tax inside
 * recomputeTotals, exactly as it imports DiscountsModule) and TenantSettingsService.
 * Mounts the admin tax-settings + rates controller and the OSS CSV export endpoint —
 * OssExportService queries the orders tables directly via DatabaseService, so TaxesModule
 * does NOT import OrdersModule (no Orders↔Taxes cycle).
 *
 * DatabaseService is @Global; AuditService is exported by the @Global AuditModule —
 * neither needs an explicit import.
 */
import { Module } from '@nestjs/common';
import { TenantSettingsService } from './tenant-settings.service';
import { TaxesRepository } from './taxes.repository';
import { TaxesService } from './taxes.service';
import { OssExportService } from './oss-export.service';
import { TaxesAdminController } from './taxes.controller.admin';

@Module({
  providers: [TenantSettingsService, TaxesRepository, TaxesService, OssExportService],
  controllers: [TaxesAdminController],
  exports: [TaxesService, TenantSettingsService],
})
export class TaxesModule {}
