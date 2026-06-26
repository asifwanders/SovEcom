/**
 * Admin Variants Controller.
 *
 * Routes: /admin/v1/products/:productId/variants
 */
import { Body, Controller, Delete, HttpCode, Param, Patch, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../authorization/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../authorization/permissions.constants';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../auth/authenticated-user';
import { VariantsService } from './variants.service';
import { CreateVariantDto } from './dto/create-variant.dto';
import { UpdateVariantDto } from './dto/update-variant.dto';
import { ReorderVariantsDto } from './dto/reorder-variants.dto';

@ApiTags('Admin / Variants')
@Controller('admin/v1/products/:productId/variants')
export class VariantsAdminController {
  constructor(private readonly service: VariantsService) {}

  @Post()
  @RequirePermission(PERMISSIONS.PRODUCTS_WRITE)
  @ApiOperation({ summary: 'Add a variant to a product' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('productId') productId: string,
    @Body() dto: CreateVariantDto,
    @Req() req: Request,
  ) {
    return this.service.create(
      user.tenantId,
      user.id,
      productId,
      dto,
      req.ip,
      req.headers['user-agent'],
    );
  }

  @Patch(':variantId')
  @RequirePermission(PERMISSIONS.PRODUCTS_WRITE)
  @ApiOperation({ summary: 'Update a variant (PATCH semantics)' })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('productId') productId: string,
    @Param('variantId') variantId: string,
    @Body() dto: UpdateVariantDto,
    @Req() req: Request,
  ) {
    return this.service.update(
      user.tenantId,
      user.id,
      productId,
      variantId,
      dto,
      req.ip,
      req.headers['user-agent'],
    );
  }

  @Delete(':variantId')
  @HttpCode(204)
  @RequirePermission(PERMISSIONS.PRODUCTS_WRITE)
  @ApiOperation({ summary: 'Delete a variant' })
  delete(
    @CurrentUser() user: AuthenticatedUser,
    @Param('productId') productId: string,
    @Param('variantId') variantId: string,
    @Req() req: Request,
  ): Promise<void> {
    return this.service.delete(
      user.tenantId,
      user.id,
      productId,
      variantId,
      req.ip,
      req.headers['user-agent'],
    );
  }

  @Post('reorder')
  @RequirePermission(PERMISSIONS.PRODUCTS_WRITE)
  @ApiOperation({ summary: 'Bulk reorder variants by position' })
  reorder(
    @CurrentUser() user: AuthenticatedUser,
    @Param('productId') productId: string,
    @Body() dto: ReorderVariantsDto,
    @Req() req: Request,
  ) {
    return this.service.reorder(
      user.tenantId,
      user.id,
      productId,
      dto.order,
      req.ip,
      req.headers['user-agent'],
    );
  }
}
