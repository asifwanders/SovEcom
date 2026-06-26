/**
 * Admin Discounts Controller. Routes: /admin/v1/discounts.
 *
 * Permission-gated with the EXISTING `settings:read` / `settings:write` permissions
 * (discounts are store-wide promotional
 * configuration, owner/admin-only; deliberately NOT a new permission or role mapping,
 * and intentionally excluded from the `staff` operational set). Mutations are
 * audit-logged via the global AuditInterceptor + @Audit (these routes do not
 * self-audit in the service layer, so no double-row).
 */
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../authorization/decorators/require-permission.decorator';
import { PERMISSIONS } from '../authorization/permissions.constants';
import { Audit } from '../audit/decorators/audit.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { DiscountsService } from './discounts.service';
import { CreateDiscountDto, UpdateDiscountDto } from './dto/discount.dto';

@ApiTags('Admin / Discounts')
@Controller('admin/v1/discounts')
export class DiscountsAdminController {
  constructor(private readonly service: DiscountsService) {}

  @Post()
  @RequirePermission(PERMISSIONS.SETTINGS_WRITE)
  @Audit('discount.created')
  @ApiOperation({ summary: 'Create a discount (code or automatic)' })
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateDiscountDto) {
    return this.service.create(user.tenantId, dto);
  }

  @Get()
  @RequirePermission(PERMISSIONS.SETTINGS_READ)
  @ApiOperation({ summary: 'List discounts' })
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.service.list(user.tenantId);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.SETTINGS_READ)
  @ApiOperation({ summary: 'Get a discount by id' })
  findOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.service.findById(user.tenantId, id);
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.SETTINGS_WRITE)
  @Audit('discount.updated')
  @ApiOperation({ summary: 'Update a discount (PATCH semantics)' })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateDiscountDto,
  ) {
    return this.service.update(user.tenantId, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission(PERMISSIONS.SETTINGS_WRITE)
  @Audit('discount.deleted')
  @ApiOperation({ summary: 'Delete a discount (refused if it has redemption history)' })
  delete(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string): Promise<void> {
    return this.service.delete(user.tenantId, id);
  }
}
