/**
 * ShippingModule.
 *
 * Provides + exports ShippingService (the cart imports this module to resolve shipping
 * inside recomputeTotals + the store rates endpoint, exactly as it imports Taxes/Discounts).
 * Mounts the admin zones + rates CRUD controller.
 *
 * DatabaseService is @Global; AuditService is exported by the @Global AuditModule —
 * neither needs an explicit import.
 */
import { Module } from '@nestjs/common';
import { ShippingRepository } from './shipping.repository';
import { ShippingService } from './shipping.service';
import { ShippingAdminController } from './shipping.controller.admin';

@Module({
  providers: [ShippingRepository, ShippingService],
  controllers: [ShippingAdminController],
  exports: [ShippingService],
})
export class ShippingModule {}
