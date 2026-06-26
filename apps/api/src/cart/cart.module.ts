/**
 * CartModule.
 *
 * Wires the cart system: repository, service, flush worker, and controller.
 * Imports:
 *  - CatalogModule  → StoreTenantService (default-tenant resolution), ProductsService
 *  - CustomersModule → CustomerAuthGuard, CustomerTokenService (for the POST /customer guard)
 *  - ScheduleModule  → @Interval / @Cron for the flush worker
 *
 * DatabaseService and RedisService are @Global — no explicit import needed.
 */
import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AuthModule } from '../auth/auth.module';
import { CatalogModule } from '../catalog/catalog.module';
import { CustomersModule } from '../customers/customers.module';
import { InventoryModule } from '../inventory/inventory.module';
import { DiscountsModule } from '../discounts/discounts.module';
import { TaxesModule } from '../taxes/taxes.module';
import { ShippingModule } from '../shipping/shipping.module';
import { CartRepository } from './cart.repository';
import { CartFlushRepository } from './cart-flush.repository';
import { CartWatchPool } from './cart-watch-pool';
import { CartService } from './cart.service';
import { CartAssociateService } from './cart-associate.service';
import { CartFlushService } from './cart-flush.service';
import { CartController } from './cart.controller';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    // AuthModule → RateLimitService (apply-discount velocity caps).
    AuthModule,
    CatalogModule,
    CustomersModule,
    InventoryModule,
    DiscountsModule,
    TaxesModule,
    ShippingModule,
  ],
  providers: [
    CartRepository,
    CartFlushRepository,
    CartWatchPool,
    CartAssociateService,
    CartService,
    CartFlushService,
  ],
  controllers: [CartController],
  // CartService for checkout authorisation; CartRepository so OrdersModule's
  // createFromCart can load the authoritative cart blob (Redis-first)
  exports: [CartService, CartRepository],
})
export class CartModule {}
