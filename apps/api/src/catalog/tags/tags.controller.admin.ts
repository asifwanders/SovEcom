/**
 * Admin Tags Controller.
 *
 * Routes: /admin/v1/tags
 */
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../authorization/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../authorization/permissions.constants';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../auth/authenticated-user';
import { TagsService } from './tags.service';
import { CreateTagDto } from './dto/create-tag.dto';
import { UpdateTagDto } from './dto/update-tag.dto';

@ApiTags('Admin / Tags')
@Controller('admin/v1/tags')
export class TagsAdminController {
  constructor(private readonly service: TagsService) {}

  @Post()
  @RequirePermission(PERMISSIONS.CATEGORIES_WRITE)
  @ApiOperation({ summary: 'Create a tag' })
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateTagDto, @Req() req: Request) {
    return this.service.create(user.tenantId, user.id, dto, req.ip, req.headers['user-agent']);
  }

  @Get()
  @RequirePermission(PERMISSIONS.CATEGORIES_READ)
  @ApiOperation({ summary: 'List tags' })
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.service.adminList(user.tenantId);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.CATEGORIES_READ)
  @ApiOperation({ summary: 'Get tag by ID' })
  findOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.service.adminFindById(user.tenantId, id);
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.CATEGORIES_WRITE)
  @ApiOperation({ summary: 'Update tag' })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateTagDto,
    @Req() req: Request,
  ) {
    return this.service.update(user.tenantId, user.id, id, dto, req.ip, req.headers['user-agent']);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission(PERMISSIONS.CATEGORIES_DELETE)
  @ApiOperation({ summary: 'Delete tag (cascades product_tags)' })
  delete(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Req() req: Request,
  ): Promise<void> {
    return this.service.delete(user.tenantId, user.id, id, req.ip, req.headers['user-agent']);
  }
}
