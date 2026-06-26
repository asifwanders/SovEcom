/**
 * InventoryModule.
 *
 * Provides the reservation engine (InventoryService) and exports it so CartModule
 * can route add/update/remove/abandon/merge through reservations. Declares the
 * expiry sweeper and the admin debug controller.
 *
 * DatabaseService is @Global. ScheduleModule.forRoot() powers the sweeper's
 * @Cron — CartModule also calls forRoot(); registering the root scheduler in
 * more than one module is supported by @nestjs/schedule (single shared registry).
 */
import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { InventoryService } from './inventory.service';
import { InventorySweeperService } from './inventory-sweeper.service';
import { InventoryAdminController } from './inventory.controller.admin';

@Module({
  imports: [ScheduleModule.forRoot()],
  providers: [InventoryService, InventorySweeperService],
  controllers: [InventoryAdminController],
  exports: [InventoryService],
})
export class InventoryModule {}
