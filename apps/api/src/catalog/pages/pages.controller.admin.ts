/**
 * Admin Pages Controller.
 *
 * Routes: /admin/v1/pages
 *
 * JWT-guarded (global guard) + @RequirePermission(PAGES_*). Admin reads return
 * the full row (id/status/timestamps are intentional for the editor). Every write
 * flows the actor / ip / user-agent into the audit log via the service, exactly
 * like CategoriesAdminController.
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
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../authorization/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../authorization/permissions.constants';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../auth/authenticated-user';
import { PagesService } from './pages.service';
import { CreatePageDto } from './dto/create-page.dto';
import { UpdatePageDto } from './dto/update-page.dto';
import { ListPagesQueryDto } from './dto/list-pages-query.dto';

@ApiTags('Admin / Pages')
@Controller('admin/v1/pages')
export class PagesAdminController {
  constructor(private readonly service: PagesService) {}

  @Post()
  @RequirePermission(PERMISSIONS.PAGES_WRITE)
  @ApiOperation({ summary: 'Create a content page' })
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreatePageDto, @Req() req: Request) {
    return this.service.create(user.tenantId, user.id, dto, req.ip, req.headers['user-agent']);
  }

  @Get()
  @RequirePermission(PERMISSIONS.PAGES_READ)
  @ApiOperation({ summary: 'List content pages (optional ?locale= & ?status= filters)' })
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListPagesQueryDto) {
    return this.service.adminList(user.tenantId, { locale: query.locale, status: query.status });
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.PAGES_READ)
  @ApiOperation({ summary: 'Get a content page by ID' })
  findOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.service.adminFindById(user.tenantId, id);
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.PAGES_WRITE)
  @ApiOperation({ summary: 'Update a content page' })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdatePageDto,
    @Req() req: Request,
  ) {
    return this.service.update(user.tenantId, user.id, id, dto, req.ip, req.headers['user-agent']);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission(PERMISSIONS.PAGES_DELETE)
  @ApiOperation({ summary: 'Delete a content page' })
  delete(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Req() req: Request,
  ): Promise<void> {
    return this.service.delete(user.tenantId, user.id, id, req.ip, req.headers['user-agent']);
  }
}
