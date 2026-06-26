/**
 * DiscountsModule.
 *
 * Provides + exports DiscountsService (the cart imports this module to evaluate
 * discounts inside recomputeTotals). Mounts the admin CRUD controller. The store
 * apply/remove-by-code surface lives on the CART controller, so there is
 * no separate store controller here.
 *
 * DatabaseService is @Global; AuditService is exported by the @Global AuditModule —
 * neither needs an explicit import.
 */
import { Module } from '@nestjs/common';
import { DiscountsRepository } from './discounts.repository';
import { DiscountsService } from './discounts.service';
import { DiscountsAdminController } from './discounts.controller.admin';

@Module({
  providers: [DiscountsRepository, DiscountsService],
  controllers: [DiscountsAdminController],
  exports: [DiscountsService],
})
export class DiscountsModule {}
