/**
 * InvoicesModule.
 *
 * Provides the invoice issuance pipeline (InvoiceService + InvoiceRepository), the
 * `order.paid` listener that drives it, and the admin + store download controllers.
 *
 * NO MODULE CYCLE: InvoicesModule does NOT import OrdersModule. The ONLY
 * link from orders → invoices is the `order.paid` EVENT (EventEmitter2, root module),
 * and InvoiceRepository reads the order + items via direct tenant-scoped queries against
 * the schema — so OrdersModule never needs to import InvoicesModule and vice-versa.
 *
 * Imports:
 *  - TaxesModule    → TenantSettingsService (read tax_mode at issuance for the regime branch).
 *  - CustomersModule → resolves CustomerAuthGuard's deps (CustomerTokenService) for the
 *                      store download route's @UseGuards(CustomerAuthGuard).
 * StorageService comes from the @Global StorageModule (no import needed). DatabaseService is
 * @Global; EventEmitter2 is from the root EventEmitterModule.
 */
import { Module } from '@nestjs/common';
import { TaxesModule } from '../taxes/taxes.module';
import { CustomersModule } from '../customers/customers.module';
import { InvoiceRepository } from './invoice.repository';
import { InvoiceService } from './invoice.service';
import { InvoiceListener } from './invoice.listener';
import { InvoicesAdminController } from './invoices.controller.admin';
import { InvoicesStoreController } from './invoices.controller.store';
import { BusinessIdentityAdminController } from './business-identity.controller.admin';

@Module({
  imports: [TaxesModule, CustomersModule],
  providers: [InvoiceRepository, InvoiceService, InvoiceListener],
  controllers: [InvoicesAdminController, InvoicesStoreController, BusinessIdentityAdminController],
  exports: [InvoiceService],
})
export class InvoicesModule {}
