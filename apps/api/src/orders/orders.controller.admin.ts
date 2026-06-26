/**
 * Admin Orders Controller. Routes: /admin/v1/orders.
 *
 * Behind the global admin JwtAuthGuard + PermissionsGuard. Permission posture:
 * READS need `orders:read` (staff + admin + owner); WRITES (transition) need `orders:write`
 * (admin + owner only — staff cannot move money/lifecycle). Every query is tenant-scoped
 * via `user.tenantId` (the DB-sourced principal). Mutations are @Audit-tagged so the global
 * AuditInterceptor records them.
 *
 *   GET  /orders              → paginated list (status / customerId facets).
 *   GET  /orders/:id          → detail incl. items + status history.
 *   POST /orders/:id/transitions {to, note}  → one legal state-machine edge (422 illegal).
 *
 * NOTE: Payment recording lives in PaymentsModule (OrdersModule must not depend on it).
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../authorization/decorators/require-permission.decorator';
import { PERMISSIONS } from '../authorization/permissions.constants';
import { Audit } from '../audit/decorators/audit.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { OrderService } from './orders.service';
import type { OrderStatus } from './order-status';
import { OrderListQueryDto, TransitionOrderDto } from './dto/order-admin.dto';

@ApiTags('Admin / Orders')
@Controller('admin/v1/orders')
export class OrdersAdminController {
  constructor(private readonly orders: OrderService) {}

  @Get()
  @RequirePermission(PERMISSIONS.ORDERS_READ)
  @ApiOperation({ summary: 'List orders (offset pagination, status / customer facets)' })
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: OrderListQueryDto) {
    return this.orders.adminList(user.tenantId, {
      page: query.page,
      pageSize: query.pageSize,
      status: query.status as OrderStatus | undefined,
      customerId: query.customerId,
    });
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.ORDERS_READ)
  @ApiOperation({ summary: 'Get an order by id (with items + status history)' })
  detail(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.orders.adminDetail(user.tenantId, id);
  }

  @Post(':id/transitions')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.ORDERS_WRITE)
  @Audit('order.transitioned')
  @ApiOperation({ summary: 'Drive one legal status transition (422 on an illegal edge)' })
  transition(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: TransitionOrderDto,
  ) {
    // `→ paid` must go through a payment-recording path: POST /payments.
    // Allowing it here would create a paid order with NO payments row and would bypass
    // the in-flight-payment guard (double-collecting a clearing SEPA). Refuse it.
    if (dto.to === 'paid') {
      throw new UnprocessableEntityException(
        'Use POST /orders/:id/payments or /orders/:id/mark-paid to record payment',
      );
    }
    // `→ refunded` / `→ partially_refunded` are likewise reserved: this generic edge never
    // moves money or writes a refund row, and `refunded` is terminal — reaching it here would
    // permanently block the real RefundService flow. Force refunds through the refunds endpoint.
    if (dto.to === 'refunded' || dto.to === 'partially_refunded') {
      throw new UnprocessableEntityException(
        'Use POST /admin/v1/orders/:id/refunds to issue a refund',
      );
    }
    return this.orders.transition(user.tenantId, id, dto.to as OrderStatus, {
      changedBy: user.id,
      note: dto.note ?? null,
    });
  }
}
