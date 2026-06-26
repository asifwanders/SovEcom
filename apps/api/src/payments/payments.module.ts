/**
 * PaymentsModule.
 *
 * Stripe payment capture: the cart-based payment-intent endpoint + the inbound webhook
 * receiver (the source of truth for "paid"). Replaces the manual mark-paid stand-in as the
 * primary paid path (the admin action remains for offline/manual methods, 2.10).
 *
 * Imports:
 *  - AuthModule      → RateLimitService (card-testing velocity caps).
 *  - OrdersModule    → OrderService (load-or-create + the state-machine transition to paid).
 *  - CartModule      → CartService (payment-intent authorisation).
 *  - CatalogModule   → StoreTenantService (default-tenant resolution for the store route).
 *  - CustomersModule → CustomerTokenService for the OptionalCustomerAuthGuard on the route.
 *
 * No cycle: OrdersModule does not import PaymentsModule (the `order.paid` link to invoices is
 * an event). The active PaymentProvider is bound to Stripe (2.9).
 */
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OrdersModule } from '../orders/orders.module';
import { CartModule } from '../cart/cart.module';
import { CatalogModule } from '../catalog/catalog.module';
import { CustomersModule } from '../customers/customers.module';
import { InvoicesModule } from '../invoices/invoices.module';
import { InventoryModule } from '../inventory/inventory.module';
import { TaxesModule } from '../taxes/taxes.module';
import { PaymentRepository } from './payment.repository';
import { PaymentEventRepository } from './payment-event.repository';
import { DisputeRepository } from './dispute.repository';
import { PaymentsService } from './payments.service';
import { PaymentWebhookService } from './payment-webhook.service';
import { RefundRepository } from './refunds/refund.repository';
import { RefundService } from './refunds/refund.service';
import { StripeService } from './stripe/stripe.service';
import { stripeClientProvider } from './stripe/stripe.client';
import { StripeProvider } from './providers/stripe.provider';
import { ManualProvider } from './providers/manual.provider';
import { MollieProvider } from './providers/mollie.provider';
import { PAYMENT_PROVIDER } from './providers/payment-provider.interface';
import { PaymentsStoreController } from './payments.controller.store';
import { PaymentsAdminController } from './payments.controller.admin';
import { RefundsAdminController } from './refunds/refunds.controller.admin';
import { StripeWebhookController } from './webhooks.controller';
import { DisputesService } from './disputes/disputes.service';
import { DisputesAdminController } from './disputes/disputes.controller.admin';

@Module({
  imports: [
    AuthModule,
    OrdersModule,
    CartModule,
    CatalogModule,
    CustomersModule,
    // refunds issue credit notes (InvoiceService), restock (InventoryService), and
    // read the tax regime (TenantSettingsService). None import PaymentsModule → no cycle.
    InvoicesModule,
    InventoryModule,
    TaxesModule,
  ],
  providers: [
    PaymentRepository,
    PaymentEventRepository,
    DisputeRepository,
    RefundRepository,
    PaymentsService,
    PaymentWebhookService,
    RefundService,
    DisputesService,
    StripeService,
    stripeClientProvider,
    StripeProvider,
    ManualProvider,
    MollieProvider,
    // The active provider for 2.9 is Stripe. Swapping providers (2.10/modules) rebinds here.
    { provide: PAYMENT_PROVIDER, useExisting: StripeProvider },
  ],
  controllers: [
    PaymentsStoreController,
    PaymentsAdminController,
    RefundsAdminController,
    DisputesAdminController,
    StripeWebhookController,
  ],
  exports: [PaymentRepository, StripeService, RefundService, RefundRepository],
})
export class PaymentsModule {}
