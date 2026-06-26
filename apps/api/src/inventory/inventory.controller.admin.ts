/**
 * Admin inventory debug controller.
 *
 * Routes: /admin/v1/inventory
 *
 * GET /reservations — view the caller-tenant's stock reservations (debug aid).
 * Gated by ORDERS_READ (reuses an existing permission — no new permission and
 * no role-map change).
 */
import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../authorization/decorators/require-permission.decorator';
import { PERMISSIONS } from '../authorization/permissions.constants';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { InventoryService } from './inventory.service';
import { ReservationQueryDto } from './dto/reservation-query.dto';

@ApiTags('Admin / Inventory')
@Controller('admin/v1/inventory')
export class InventoryAdminController {
  constructor(private readonly inventory: InventoryService) {}

  @Get('reservations')
  @RequirePermission(PERMISSIONS.ORDERS_READ)
  @ApiOperation({ summary: 'List stock reservations for the tenant (debug)' })
  async listReservations(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ReservationQueryDto,
  ): Promise<{ reservations: ReservationView[] }> {
    const rows = await this.inventory.listReservations(user.tenantId, query.variantId);
    return {
      reservations: rows.map((r) => ({
        id: r.id,
        variantId: r.variantId,
        cartId: r.cartId,
        quantity: r.quantity,
        status: r.status,
        expiresAt: r.expiresAt.toISOString(),
        createdAt: r.createdAt.toISOString(),
      })),
    };
  }
}

interface ReservationView {
  id: string;
  variantId: string;
  cartId: string;
  quantity: number;
  status: string;
  expiresAt: string;
  createdAt: string;
}
