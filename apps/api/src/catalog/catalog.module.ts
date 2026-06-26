/**
 *  1.7 — CatalogModule.
 *
 * Imports AuthModule to get RateLimitService for the store rate-limit guard.
 * DatabaseService and StorageService are @Global — no explicit import needed.
 *
 *adds: CategoriesRepository, CategoriesService, TagsRepository
 * TagsService, TaxonomyAssignmentService, and their controllers.
 */
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ProductsRepository } from './products/products.repository';
import { VariantsRepository } from './variants/variants.repository';
import { ProductsService } from './products/products.service';
import { VariantsService } from './variants/variants.service';
import { StoreTenantService } from './store-tenant.service';
import { CategoriesRepository } from './categories/categories.repository';
import { CategoriesService } from './categories/categories.service';
import { TagsRepository } from './tags/tags.repository';
import { TagsService } from './tags/tags.service';
import { TaxonomyAssignmentService } from './taxonomy-assignment.service';
import { PagesRepository } from './pages/pages.repository';
import { PagesService } from './pages/pages.service';
import { ProductsAdminController } from './products/products.controller.admin';
import { ProductsStoreController } from './products/products.controller.store';
import { VariantsAdminController } from './variants/variants.controller.admin';
import { CategoriesAdminController } from './categories/categories.controller.admin';
import { CategoriesStoreController } from './categories/categories.controller.store';
import { TagsAdminController } from './tags/tags.controller.admin';
import { TagsStoreController } from './tags/tags.controller.store';
import { PagesAdminController } from './pages/pages.controller.admin';
import { PagesStoreController } from './pages/pages.controller.store';

@Module({
  imports: [AuthModule],
  providers: [
    ProductsRepository,
    VariantsRepository,
    ProductsService,
    VariantsService,
    StoreTenantService,
    CategoriesRepository,
    CategoriesService,
    TagsRepository,
    TagsService,
    TaxonomyAssignmentService,
    PagesRepository,
    PagesService,
  ],
  controllers: [
    ProductsAdminController,
    ProductsStoreController,
    VariantsAdminController,
    CategoriesAdminController,
    CategoriesStoreController,
    TagsAdminController,
    TagsStoreController,
    PagesAdminController,
    PagesStoreController,
  ],
  exports: [
    ProductsService,
    VariantsService,
    CategoriesService,
    TagsService,
    // CustomersModule reuses StoreTenantService to resolve the default
    // tenant for anonymous store signup/login.
    StoreTenantService,
  ],
})
export class CatalogModule {}
