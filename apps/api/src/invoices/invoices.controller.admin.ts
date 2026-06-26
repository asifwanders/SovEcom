/**
 * Admin invoice download. Route: /admin/v1/orders/:orderId/invoice.
 *
 * Behind the GLOBAL admin JwtAuthGuard + PermissionsGuard. Needs `orders:read` (the invoice
 * is part of the order record). Streams the stored PDF, or renders it on demand from the
 * immutable snapshot when storage_key is null (a prior render/store failure). 404 when no
 * invoice exists for the order in this tenant. Tenant-scoped via `user.tenantId`.
 */
import { Controller, Get, HttpCode, Param, Post, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { RequirePermission } from '../authorization/decorators/require-permission.decorator';
import { PERMISSIONS } from '../authorization/permissions.constants';
import { Audit } from '../audit/decorators/audit.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { InvoiceService } from './invoice.service';

@ApiTags('Admin / Orders')
@Controller('admin/v1/orders')
export class InvoicesAdminController {
  constructor(private readonly invoices: InvoiceService) {}

  @Get(':orderId/invoice')
  @RequirePermission(PERMISSIONS.ORDERS_READ)
  @ApiOperation({ summary: "Download an order's invoice PDF (404 if none issued)" })
  async download(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId') orderId: string,
    @Res() res: Response,
  ): Promise<void> {
    const { filename, bytes } = await this.invoices.getInvoicePdfForOrder(user.tenantId, orderId);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.setHeader('Content-Length', String(bytes.length));
    res.send(bytes);
  }

  @Post(':orderId/invoice/reissue')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.ORDERS_WRITE)
  @Audit('invoice.reissued')
  @ApiOperation({
    summary: 'Re-render + store an invoice PDF whose render previously failed (storage_key null)',
  })
  async reissue(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId') orderId: string,
  ): Promise<{ reissued: boolean; invoiceNumber: string }> {
    const { invoice, reissued } = await this.invoices.reissuePdfForOrder(user.tenantId, orderId);
    return { reissued, invoiceNumber: invoice.invoiceNumber };
  }
}
