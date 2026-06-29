/**
 *  1.7 — Admin Products Controller.
 *
 * Routes: /admin/v1/products
 *
 *adds: PUT /admin/v1/products/:id/categories and /tags
 * for replace-set taxonomy assignment (PRODUCTS_WRITE).
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../authorization/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../authorization/permissions.constants';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../auth/authenticated-user';
import { ProductsService } from './products.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { ProductQueryDto } from './dto/product-query.dto';
import { AttachImageDto, ReorderImagesDto } from './dto/attach-image.dto';
import { TaxonomyAssignmentService } from '../taxonomy-assignment.service';
import { AssignCategoriesDto } from '../categories/dto/assign-categories.dto';
import { AssignTagsDto } from '../tags/dto/assign-tags.dto';

@ApiTags('Admin / Products')
@Controller('admin/v1/products')
export class ProductsAdminController {
  constructor(
    private readonly service: ProductsService,
    private readonly taxonomy: TaxonomyAssignmentService,
  ) {}

  @Post()
  @RequirePermission(PERMISSIONS.PRODUCTS_WRITE)
  @ApiOperation({ summary: 'Create a product (with optional variants)' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateProductDto,
    @Req() req: Request,
  ) {
    return this.service.create(user.tenantId, user.id, dto, req.ip, req.headers['user-agent']);
  }

  @Get()
  @RequirePermission(PERMISSIONS.PRODUCTS_READ)
  @ApiOperation({ summary: 'List products (offset pagination, filters, sort)' })
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ProductQueryDto) {
    return this.service.adminList(user.tenantId, {
      page: query.page,
      pageSize: query.pageSize,
      q: query.q,
      status: query.status,
      category: query.category,
      tag: query.tag,
      priceMin: query.priceMin,
      priceMax: query.priceMax,
      inStock: query.inStock as boolean | undefined,
      sort: query.sort,
      order: query.order,
    });
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.PRODUCTS_READ)
  @ApiOperation({ summary: 'Get product by ID with variants and images' })
  findOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.service.adminFindById(user.tenantId, id);
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.PRODUCTS_WRITE)
  @ApiOperation({ summary: 'Update product (PATCH semantics)' })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateProductDto,
    @Req() req: Request,
  ) {
    return this.service.update(user.tenantId, user.id, id, dto, req.ip, req.headers['user-agent']);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission(PERMISSIONS.PRODUCTS_WRITE)
  @ApiOperation({ summary: 'Hard delete product (CASCADE removes variants/images)' })
  delete(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Req() req: Request,
  ): Promise<void> {
    return this.service.delete(user.tenantId, user.id, id, req.ip, req.headers['user-agent']);
  }

  // ── Image sub-resource ───────────────────────────────────────────────────────

  @Post(':id/images')
  @RequirePermission(PERMISSIONS.PRODUCTS_WRITE)
  @ApiOperation({ summary: 'Attach an uploaded image to a product' })
  attachImage(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') productId: string,
    @Body() dto: AttachImageDto,
    @Req() req: Request,
  ) {
    return this.service.attachImage(
      user.tenantId,
      user.id,
      productId,
      dto.imageId,
      dto.position ?? 0,
      req.ip,
      req.headers['user-agent'],
    );
  }

  @Delete(':id/images/:imageId')
  @HttpCode(204)
  @RequirePermission(PERMISSIONS.PRODUCTS_WRITE)
  @ApiOperation({ summary: 'Detach an image from a product' })
  detachImage(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') productId: string,
    @Param('imageId') imageId: string,
    @Req() req: Request,
  ): Promise<void> {
    return this.service.detachImage(
      user.tenantId,
      user.id,
      productId,
      imageId,
      req.ip,
      req.headers['user-agent'],
    );
  }

  @Post(':id/images/reorder')
  @RequirePermission(PERMISSIONS.PRODUCTS_WRITE)
  @ApiOperation({ summary: 'Reorder product images' })
  reorderImages(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') productId: string,
    @Body() dto: ReorderImagesDto,
    @Req() req: Request,
  ) {
    return this.service.reorderImages(
      user.tenantId,
      user.id,
      productId,
      dto.order,
      req.ip,
      req.headers['user-agent'],
    );
  }

  // ── taxonomy assignment ──────────────────────────────────────────

  @Put(':id/categories')
  @HttpCode(204)
  @RequirePermission(PERMISSIONS.PRODUCTS_WRITE)
  @ApiOperation({ summary: 'Replace product category set (replace-set semantics)' })
  assignCategories(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') productId: string,
    @Body() dto: AssignCategoriesDto,
    @Req() req: Request,
  ): Promise<void> {
    return this.taxonomy.assignCategories(
      user.tenantId,
      user.id,
      productId,
      dto.categoryIds,
      req.ip,
      req.headers['user-agent'],
    );
  }

  @Put(':id/tags')
  @HttpCode(204)
  @RequirePermission(PERMISSIONS.PRODUCTS_WRITE)
  @ApiOperation({ summary: 'Replace product tag set (replace-set semantics)' })
  assignTags(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') productId: string,
    @Body() dto: AssignTagsDto,
    @Req() req: Request,
  ): Promise<void> {
    return this.taxonomy.assignTags(
      user.tenantId,
      user.id,
      productId,
      dto.tagIds,
      req.ip,
      req.headers['user-agent'],
    );
  }
}
