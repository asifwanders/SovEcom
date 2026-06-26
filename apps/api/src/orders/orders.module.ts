/**
 * OrdersModule.
 *
 * Provides the order state machine (OrderService.transition, C1) and order creation
 * (OrderService.createFromCart, C2/C3) plus the tenant-scoped OrderRepository, and the
 * store checkout controller.
 *
 * Imports (createFromCart's collaborators):
 *  - CartModule      → CartService (checkout authorisation) + CartRepository (load the
 *                      authoritative Redis-first cart blob).
 *  - InventoryModule → InventoryService (consume reservations + bundle components in the tx).
 *  - DiscountsModule / TaxesModule / ShippingModule → server-side totals recompute.
 *  - CatalogModule   → StoreTenantService (default-tenant resolution for the store route).
 *  - CustomersModule → CustomerTokenService for the OptionalCustomerAuthGuard on the route.
 *
 * No cycle: none of these import OrdersModule (Cart/Inventory/etc. are all upstream).
 * DatabaseService is @Global and EventEmitter2 comes from the root EventEmitterModule.
 */
import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { CartModule } from '../cart/cart.module';
import { InventoryModule } from '../inventory/inventory.module';
import { DiscountsModule } from '../discounts/discounts.module';
import { TaxesModule } from '../taxes/taxes.module';
import { ShippingModule } from '../shipping/shipping.module';
import { CatalogModule } from '../catalog/catalog.module';
import { CustomersModule } from '../customers/customers.module';
import { OrderRepository } from './order.repository';
import { OrderService } from './orders.service';
import { OrderRestockListener } from './order-restock.listener';
import { StaleOrderSweeperService } from './stale-order-sweeper.service';
import { OrdersStoreController } from './orders.controller.store';
import { OrdersReadStoreController } from './orders-read.controller.store';
import { OrdersGuestStoreController } from './orders-guest.controller.store';
import { OrdersAdminController } from './orders.controller.admin';

@Module({
  imports: [
    // Powers the stale-unpaid-order @Cron. forRoot is idempotent across modules
    // (cart + inventory already register it — see those modules).
    ScheduleModule.forRoot(),
    CartModule,
    InventoryModule,
    DiscountsModule,
    TaxesModule,
    ShippingModule,
    CatalogModule,
    CustomersModule,
  ],
  providers: [OrderRepository, OrderService, OrderRestockListener, StaleOrderSweeperService],
  controllers: [
    OrdersStoreController,
    OrdersReadStoreController,
    OrdersGuestStoreController,
    OrdersAdminController,
  ],
  exports: [OrderService, OrderRepository, StaleOrderSweeperService],
})
export class OrdersModule {}
