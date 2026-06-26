/**
 * Admin Categories Controller.
 *
 * Routes: /admin/v1/categories
 */
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../authorization/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../authorization/permissions.constants';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../auth/authenticated-user';
import { CategoriesService } from './categories.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';

@ApiTags('Admin / Categories')
@Controller('admin/v1/categories')
export class CategoriesAdminController {
  constructor(private readonly service: CategoriesService) {}

  @Post()
  @RequirePermission(PERMISSIONS.CATEGORIES_WRITE)
  @ApiOperation({ summary: 'Create a category' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateCategoryDto,
    @Req() req: Request,
  ) {
    return this.service.create(user.tenantId, user.id, dto, req.ip, req.headers['user-agent']);
  }

  @Get()
  @RequirePermission(PERMISSIONS.CATEGORIES_READ)
  @ApiOperation({ summary: 'List categories (flat, with parentId)' })
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.service.adminList(user.tenantId);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.CATEGORIES_READ)
  @ApiOperation({ summary: 'Get category by ID' })
  findOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.service.adminFindById(user.tenantId, id);
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.CATEGORIES_WRITE)
  @ApiOperation({ summary: 'Update category (rename, reslug, re-parent, reposition)' })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateCategoryDto,
    @Req() req: Request,
  ) {
    return this.service.update(user.tenantId, user.id, id, dto, req.ip, req.headers['user-agent']);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission(PERMISSIONS.CATEGORIES_DELETE)
  @ApiOperation({ summary: 'Delete category (blocked if children exist)' })
  delete(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Req() req: Request,
  ): Promise<void> {
    return this.service.delete(user.tenantId, user.id, id, req.ip, req.headers['user-agent']);
  }
}
