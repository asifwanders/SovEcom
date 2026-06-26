/**
 * SlotsModule — the slot registry + admin conflict-resolution surface.
 *
 * The registry DERIVES the slot → component map from ENABLED modules' DECLARED slot targets
 * (`installed_modules WHERE enabled`) + the admin's `module_slot_resolutions`. Slots are pure
 * declarative metadata — NO code runs here. `DatabaseService` + the AuditModule interceptor are
 * @Global. CatalogModule exports StoreTenantService (default-tenant for the public store map);
 * AuthModule exports RateLimitService (the store-endpoint rate limit) — it is NOT global, so it
 * must be imported, mirroring ThemesModule.
 */
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CatalogModule } from '../catalog/catalog.module';
import { SlotsRepository } from './slots.repository';
import { SlotRegistryService } from './slot-registry.service';
import { SlotsAdminController } from './slots.controller.admin';
import { SlotsStoreController } from './slots.controller.store';

@Module({
  imports: [AuthModule, CatalogModule],
  providers: [SlotsRepository, SlotRegistryService],
  controllers: [SlotsAdminController, SlotsStoreController],
  exports: [SlotRegistryService],
})
export class SlotsModule {}
