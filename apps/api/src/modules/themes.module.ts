/**
 * ThemesModule — admin-side theme install/registry + activation flow, plus the public store theme endpoint.
 *
 * Themes are declarative assets — no worker, no SDK broker, no permission grant, no
 * database isolation (a theme owns no tables). Install reuses the shared hardened tarball extractor
 * (with the same security guards as modules — see `runtime/guarded-tar.ts`) via {@link ThemeIngestService};
 * no theme code ever runs. `DatabaseService` + the AuditModule interceptor are @Global.
 */
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CatalogModule } from '../catalog/catalog.module';
import { TaxesModule } from '../taxes/taxes.module';
import { ThemesRepository } from './themes.repository';
import { ThemesService } from './themes.service';
import { ThemeIngestService } from './theme-ingest.service';
import { ThemesAdminController } from './themes.controller.admin';
import { ThemesStoreController } from './themes.controller.store';

@Module({
  // CatalogModule exports StoreTenantService (default-tenant for the public store theme
  // endpoint); AuthModule exports RateLimitService (the store-endpoint rate limit) — it is NOT
  // global, so it must be imported, mirroring other modules.
  // TaxesModule exports TenantSettingsService for reading analytics config.
  imports: [AuthModule, CatalogModule, TaxesModule],
  providers: [
    ThemesRepository,
    ThemesService,
    // Default construction reads THEMES_DATA_PATH from env.
    { provide: ThemeIngestService, useFactory: () => new ThemeIngestService() },
  ],
  controllers: [ThemesAdminController, ThemesStoreController],
  exports: [ThemesService],
})
export class ThemesModule {}
