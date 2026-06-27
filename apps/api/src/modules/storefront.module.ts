/**
 * StorefrontModule — admin home-sections CRUD + public store home-sections endpoint.
 *
 * The home-sections table is a singleton per tenant — no worker, no SDK, no permission grant.
 * Validation uses `@sovecom/theme-sdk`'s `parseMarketingSection` (imported at the service layer)
 * as the single source of truth. `DatabaseService` + AuditModule interceptor are @Global.
 *
 * Imports mirror ThemesModule:
 *   - AuthModule → exports RateLimitService (public store rate limit)
 *   - CatalogModule → exports StoreTenantService (default tenant for the store endpoint)
 */
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CatalogModule } from '../catalog/catalog.module';
import { HomeSectionsRepository } from './home-sections.repository';
import { HomeSectionsService } from './home-sections.service';
import { HomeSectionsAdminController } from './home-sections.controller.admin';
import { HomeSectionsStoreController } from './home-sections.controller.store';

@Module({
  // AuthModule exports RateLimitService (store endpoint rate limit).
  // CatalogModule exports StoreTenantService (default-tenant resolution for the store endpoint).
  imports: [AuthModule, CatalogModule],
  providers: [HomeSectionsRepository, HomeSectionsService],
  controllers: [HomeSectionsAdminController, HomeSectionsStoreController],
  exports: [HomeSectionsService],
})
export class StorefrontModule {}
