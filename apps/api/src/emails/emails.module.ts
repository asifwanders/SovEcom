/**
 * EmailsModule.
 *
 * Transactional commerce emails: listens for `order.created` / `order.shipped` / `refund.issued`
 * and sends order-confirmation / shipped / refund emails through the existing MailService seam,
 * with inline retry + an `email_logs` record. Admin can list logs + resend.
 *
 * Imports:
 *  - OrdersModule   → OrderRepository (order + items for the templates).
 *  - PaymentsModule → RefundRepository (refund amount/currency for resend re-render).
 *  - InvoicesModule → InvoiceService (credit-note reference in the refund email).
 *  MailModule is @Global (MAIL_SERVICE token), so no import needed.
 *
 * No cycle: none of these import EmailsModule.
 */
import { Module } from '@nestjs/common';
import { OrdersModule } from '../orders/orders.module';
import { PaymentsModule } from '../payments/payments.module';
import { InvoicesModule } from '../invoices/invoices.module';
import { CustomersModule } from '../customers/customers.module';
import { EmailLogRepository } from './email-log.repository';
import { EmailComposer } from './email-composer.service';
import { EmailNotificationService } from './email-notification.service';
import { OrderEmailListener } from './listeners/order-email.listener';
import { EmailsAdminController } from './emails.controller.admin';

@Module({
  imports: [OrdersModule, PaymentsModule, InvoicesModule, CustomersModule],
  providers: [EmailLogRepository, EmailComposer, EmailNotificationService, OrderEmailListener],
  controllers: [EmailsAdminController],
  exports: [EmailNotificationService],
})
export class EmailsModule {}
