/**
 * ReturnsModule.
 *
 * Returns / 14-day withdrawal: customer request + admin approve(→2.11 refund)/reject.
 *
 * Imports:
 *  - OrdersModule   → OrderService (own-order no-IDOR load) + OrderRepository (delivery ts, items).
 *  - PaymentsModule → RefundService (approve issues the refund + credit note + restock).
 *  - CustomersModule→ CustomerAuthGuard for the store endpoints.
 *
 * No cycle: none of these import ReturnsModule.
 */
import { Module } from '@nestjs/common';
import { OrdersModule } from '../orders/orders.module';
import { PaymentsModule } from '../payments/payments.module';
import { CustomersModule } from '../customers/customers.module';
import { ReturnRepository } from './return.repository';
import { ReturnsService } from './returns.service';
import { ReturnsStoreController } from './returns.controller.store';
import { ReturnsAdminController } from './returns.controller.admin';

@Module({
  imports: [OrdersModule, PaymentsModule, CustomersModule],
  providers: [ReturnRepository, ReturnsService],
  controllers: [ReturnsStoreController, ReturnsAdminController],
  exports: [ReturnsService],
})
export class ReturnsModule {}
