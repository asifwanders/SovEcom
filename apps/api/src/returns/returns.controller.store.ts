/**
 * Store returns controller (SECURITY-CRITICAL: no IDOR).
 * Routes: /store/v1/customers/me/orders/:orderId/returns. Requires a customer JWT; every action
 * scopes to `customer.id` from the guard principal (never a path/body id), and the order is
 * resolved via the own-order load so another customer's order id 404s (no enumeration oracle).
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import { CustomerAuthGuard } from '../customers/auth/customer-auth.guard';
import { CurrentCustomer } from '../customers/auth/customer-current.decorator';
import type { AuthenticatedCustomer } from '../customers/auth/authenticated-customer';
import { ReturnsService } from './returns.service';
import { CreateReturnDto } from './dto/return.dto';
import type { ReturnType, ReturnItem } from './return.types';

@ApiTags('Store / Returns')
@Public()
@UseGuards(CustomerAuthGuard)
@Controller('store/v1/customers/me/orders')
export class ReturnsStoreController {
  constructor(private readonly returns: ReturnsService) {}

  @Post(':orderId/returns')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Request a return / 14-day withdrawal on MY order (no IDOR)' })
  async request(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Param('orderId') orderId: string,
    @Body() dto: CreateReturnDto,
  ) {
    const row = await this.returns.request(customer.tenantId, customer.id, orderId, {
      type: dto.type as ReturnType,
      items: dto.items as ReturnItem[],
      reason: dto.reason ?? null,
    });
    return this.serialize(row);
  }

  @Get(':orderId/returns')
  @ApiOperation({ summary: 'List MY return requests for this order' })
  async list(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Param('orderId') orderId: string,
  ) {
    const rows = await this.returns.listForCustomerOrder(customer.tenantId, customer.id, orderId);
    return rows.map((r) => this.serialize(r));
  }

  /** Storefront return view — no internal columns (tenant_id, resolved_by). */
  private serialize(r: {
    id: string;
    orderId: string;
    type: string;
    status: string;
    items: unknown;
    reason: string | null;
    withinWithdrawalWindow: boolean;
    requestedAt: Date;
    refundId: string | null;
  }): Record<string, unknown> {
    return {
      id: r.id,
      orderId: r.orderId,
      type: r.type,
      status: r.status,
      items: r.items,
      reason: r.reason,
      withinWithdrawalWindow: r.withinWithdrawalWindow,
      requestedAt: r.requestedAt,
      refundId: r.refundId,
    };
  }
}
