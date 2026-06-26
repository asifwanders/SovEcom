/**
 * Admin refunds. `POST /admin/v1/orders/:orderId/refunds`.
 *
 * Behind the GLOBAL admin JwtAuthGuard + PermissionsGuard; needs `orders:write` (moving money —
 * admin + owner only). Audited. Tenant-scoped via user.tenantId. Issues the refund + a credit note
 * and drives the order to refunded / partially_refunded.
 */
import { Body, Controller, HttpCode, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../authorization/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../authorization/permissions.constants';
import { Audit } from '../../audit/decorators/audit.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../auth/authenticated-user';
import { RefundService } from './refund.service';
import { RefundDto } from '../dto/refund.dto';

@ApiTags('Admin / Orders')
@Controller('admin/v1/orders')
export class RefundsAdminController {
  constructor(private readonly refunds: RefundService) {}

  @Post(':orderId/refunds')
  @HttpCode(201)
  @RequirePermission(PERMISSIONS.ORDERS_WRITE)
  @Audit('order.refunded')
  @ApiOperation({ summary: 'Issue a refund (full / line-item / partial-amount) + a credit note' })
  refund(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId') orderId: string,
    @Body() dto: RefundDto,
  ) {
    return this.refunds.create(user.tenantId, orderId, {
      reason: dto.reason ?? null,
      items: dto.items,
      amount: dto.amount,
      restock: dto.restock,
      idempotencyKey: dto.idempotencyKey,
      actorUserId: user.id,
    });
  }
}
