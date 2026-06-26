/**
 * Admin disputes controller. Routes: /admin/v1/disputes.
 *
 * Behind the GLOBAL admin JwtAuthGuard + PermissionsGuard. LIST (queue + the order-detail panel,
 * which filters by `orderId`) needs `orders:read`. UNFREEZE clears the fulfillment freeze a dispute
 * placed on its order — `orders:write` (lifecycle gate), @Audit-tagged. Won/lost resolution is NOT
 * exposed (webhook-driven — Stripe is the source of truth). Tenant-scoped.
 */
import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../authorization/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../authorization/permissions.constants';
import { Audit } from '../../audit/decorators/audit.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../auth/authenticated-user';
import { DisputesService } from './disputes.service';
import { DisputesQueryDto } from './dto/dispute.dto';
import type { DisputeStatus } from './dispute.types';

@ApiTags('Admin / Disputes')
@Controller('admin/v1/disputes')
export class DisputesAdminController {
  constructor(private readonly disputes: DisputesService) {}

  @Get()
  @RequirePermission(PERMISSIONS.ORDERS_READ)
  @ApiOperation({ summary: 'Dispute queue (filter by status/order, offset pagination)' })
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: DisputesQueryDto) {
    return this.disputes.list(user.tenantId, {
      status: query.status as DisputeStatus | undefined,
      orderId: query.orderId,
      page: query.page,
      pageSize: query.pageSize,
    });
  }

  @Post(':id/unfreeze-fulfillment')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.ORDERS_WRITE)
  @Audit('dispute.fulfillment_unfrozen')
  @ApiOperation({ summary: 'Clear the fulfillment freeze a dispute placed on its order' })
  unfreeze(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.disputes.unfreezeFulfillment(user.tenantId, id);
  }
}
