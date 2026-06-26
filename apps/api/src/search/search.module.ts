/**
 * SearchModule.
 *
 * Wires: SearchService (lazy Meilisearch client) + ProductIndexer (@OnEvent subscribers) +
 * SearchQueryService + SearchStoreController.
 *
 * Imports:
 *   - AuthModule       → RateLimitService (store rate-limit guard)
 *   - CatalogModule    → StoreTenantService (resolve default tenant for store) + ProductsRepository
 *   - StorageModule    → StorageService (thumbnail URL generation in ProductIndexer)
 *
 * DatabaseService and StorageService are @Global, so they inject without an explicit import.
 * This module IS @Global, so exported providers are available app-wide without re-importing.
 */
import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CatalogModule } from '../catalog/catalog.module';
import { TaxesModule } from '../taxes/taxes.module';
import { SearchService } from './search.service';
import { ProductIndexer } from './indexers/product.indexer';
import { SearchQueryService } from './search-query.service';
import { SearchStoreController } from './controllers/search.controller.store';

// TaxesModule supplies the exported TenantSettingsService (the store default-currency
// seam) that ProductIndexer reads to pick a canonical currency for the index doc.
@Global()
@Module({
  imports: [AuthModule, CatalogModule, TaxesModule],
  providers: [SearchService, ProductIndexer, SearchQueryService],
  controllers: [SearchStoreController],
  exports: [SearchService, SearchQueryService, ProductIndexer],
})
export class SearchModule {}
