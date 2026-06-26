/**
 * Admin returns controller. Routes: /admin/v1/returns.
 *
 * Behind the GLOBAL admin JwtAuthGuard + PermissionsGuard. READ (queue) needs `orders:read`
 * (staff+); WRITES (approve/reject — money + lifecycle) need `orders:write` (admin+). Approve
 * issues the 2.11 refund + credit note + restock. Mutations are @Audit-tagged. Tenant-scoped.
 */
import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../authorization/decorators/require-permission.decorator';
import { PERMISSIONS } from '../authorization/permissions.constants';
import { Audit } from '../audit/decorators/audit.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { ReturnsService } from './returns.service';
import { ReturnsQueryDto, RejectReturnDto } from './dto/return.dto';
import type { ReturnStatus } from './return.types';

@ApiTags('Admin / Returns')
@Controller('admin/v1/returns')
export class ReturnsAdminController {
  constructor(private readonly returns: ReturnsService) {}

  @Get()
  @RequirePermission(PERMISSIONS.ORDERS_READ)
  @ApiOperation({ summary: 'Return queue (offset pagination, optional status filter)' })
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ReturnsQueryDto) {
    return this.returns.listForAdmin(user.tenantId, {
      status: query.status as ReturnStatus | undefined,
      page: query.page,
      pageSize: query.pageSize,
    });
  }

  @Post(':id/approve')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.ORDERS_WRITE)
  @Audit('return.approved')
  @ApiOperation({ summary: 'Approve a return → issue refund + credit note + restock (§2.11)' })
  approve(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.returns.approve(user.tenantId, id, user.id);
  }

  @Post(':id/reject')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.ORDERS_WRITE)
  @Audit('return.rejected')
  @ApiOperation({ summary: 'Reject a return with a reason' })
  reject(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: RejectReturnDto,
  ) {
    return this.returns.reject(user.tenantId, id, user.id, dto.reason);
  }
}
