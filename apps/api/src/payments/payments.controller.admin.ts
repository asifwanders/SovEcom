/**
 * Admin manual/offline payments. Routes under /admin/v1/orders.
 *
 * Behind the GLOBAL admin JwtAuthGuard + PermissionsGuard; needs `orders:write` (moving money/
 * lifecycle — admin + owner only, per the 2.8 posture). Relocated here from OrdersAdminController
 * so it can write a `payments` row via PaymentsService without an OrdersModule→PaymentsModule cycle.
 * Every mutation is @Audit-tagged for the global AuditInterceptor. Tenant-scoped via user.tenantId.
 *
 *   POST /orders/:orderId/payments   {method, amount?}  → record an offline payment + → paid.
 *   POST /orders/:orderId/mark-paid                      → convenience alias (full amount).
 */
import { Body, Controller, HttpCode, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../authorization/decorators/require-permission.decorator';
import { PERMISSIONS } from '../authorization/permissions.constants';
import { Audit } from '../audit/decorators/audit.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { PaymentsService } from './payments.service';
import { ManualPaymentDto } from './dto/manual-payment.dto';

@ApiTags('Admin / Orders')
@Controller('admin/v1/orders')
export class PaymentsAdminController {
  constructor(private readonly payments: PaymentsService) {}

  @Post(':orderId/payments')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.ORDERS_WRITE)
  @Audit('order.manual_payment')
  @ApiOperation({ summary: 'Record a manual/offline payment (bank transfer / COD / cash) → paid' })
  recordManual(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId') orderId: string,
    @Body() dto: ManualPaymentDto,
  ) {
    return this.payments.recordManualPayment(user.tenantId, orderId, {
      method: dto.method,
      amount: dto.amount,
      actorUserId: user.id,
    });
  }

  @Post(':orderId/mark-paid')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.ORDERS_WRITE)
  @Audit('order.marked_paid')
  @ApiOperation({ summary: 'Mark an order paid (manual, full amount) — convenience alias' })
  markPaid(@CurrentUser() user: AuthenticatedUser, @Param('orderId') orderId: string) {
    return this.payments.recordManualPayment(user.tenantId, orderId, {
      method: 'other',
      actorUserId: user.id,
    });
  }
}
