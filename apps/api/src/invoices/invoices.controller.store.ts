/**
 * Store invoice download (SECURITY-CRITICAL: no IDOR).
 * Route: /store/v1/orders/:orderId/invoice. REQUIRES a customer JWT (CustomerAuthGuard);
 * `@Public()` only skips the GLOBAL admin guards — CustomerAuthGuard re-imposes customer auth.
 *
 * The order MUST belong to the authenticated customer (from the guard-set principal, NEVER a
 * path id) in this tenant. Another customer's order, a guest order, or an order with no
 * invoice ALL resolve to 404 — an order id is not an existence/enumeration oracle. The
 * ownership check runs BEFORE we touch the invoice, so we never leak that an invoice exists
 * for someone else's order. Streams from storage, or renders on demand from the snapshot.
 */
import { Controller, Get, NotFoundException, Param, Res, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../auth/decorators/public.decorator';
import { CustomerAuthGuard } from '../customers/auth/customer-auth.guard';
import { CurrentCustomer } from '../customers/auth/customer-current.decorator';
import type { AuthenticatedCustomer } from '../customers/auth/authenticated-customer';
import { InvoiceService } from './invoice.service';
import { InvoiceRepository } from './invoice.repository';

@ApiTags('Store / Orders')
@Public()
@UseGuards(CustomerAuthGuard)
@Controller('store/v1/orders')
export class InvoicesStoreController {
  constructor(
    private readonly invoices: InvoiceService,
    private readonly repo: InvoiceRepository,
  ) {}

  @Get(':orderId/invoice')
  @ApiOperation({ summary: 'Download MY order invoice PDF (404 on any order not mine — no IDOR)' })
  async download(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Param('orderId') orderId: string,
    @Res() res: Response,
  ): Promise<void> {
    // IDOR guard FIRST: not my order (or a guest order) → 404, no existence leak.
    const owns = await this.repo.orderBelongsToCustomer(customer.tenantId, orderId, customer.id);
    if (!owns) {
      throw new NotFoundException(`No invoice for order ${orderId}`);
    }

    const { filename, bytes } = await this.invoices.getInvoicePdfForOrder(
      customer.tenantId,
      orderId,
    );
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.setHeader('Content-Length', String(bytes.length));
    res.send(bytes);
  }
}
