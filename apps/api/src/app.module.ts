import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './common/env.validation';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { HealthModule } from './health/health.module';
import { DatabaseModule } from './database/database.module';
import { RedisModule } from './redis/redis.module';
import { SearchModule } from './search/search.module';
import { AuditModule } from './audit/audit.module';
import { MailModule } from './mail/mail.module';
import { AuthModule } from './auth/auth.module';
import { AuthorizationModule } from './authorization/authorization.module';
import { StorageModule } from './storage/storage.module';
import { ImagesModule } from './images/images.module';
import { CatalogModule } from './catalog/catalog.module';
import { CustomersModule } from './customers/customers.module';
import { CartModule } from './cart/cart.module';
import { InventoryModule } from './inventory/inventory.module';
import { DiscountsModule } from './discounts/discounts.module';
import { TaxesModule } from './taxes/taxes.module';
import { ShippingModule } from './shipping/shipping.module';
import { OrdersModule } from './orders/orders.module';
import { InvoicesModule } from './invoices/invoices.module';
import { PaymentsModule } from './payments/payments.module';
import { ReturnsModule } from './returns/returns.module';
import { EmailsModule } from './emails/emails.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { SetupModule } from './setup/setup.module';
import { ModulesModule } from './modules/modules.module';
import { ThemesModule } from './modules/themes.module';
import { StorefrontModule } from './modules/storefront.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { SlotsModule } from './modules/slots.module';

@Module({
  imports: [
    // Central env validation (H2): fail-closed in production on missing/weak
    // core vars; permissive in dev/test. Coexists with the per-service guards.
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    // Global event bus for domain events.
    EventEmitterModule.forRoot({ wildcard: false }),
    DatabaseModule,
    RedisModule,
    SearchModule,
    AuditModule,
    MailModule,
    AuthModule,
    // After AuthModule: JwtAuthGuard (sets req.user) must run before the
    // PermissionsGuard registered by AuthorizationModule.
    AuthorizationModule,
    StorageModule,
    ImagesModule,
    CatalogModule,
    CustomersModule,
    // Inventory reservation engine (no-oversell). Before CartModule
    // so its exported InventoryService is available for cart wiring.
    InventoryModule,
    // Discount engine. Before CartModule so its exported
    // DiscountsService is available for cart-totals wiring.
    DiscountsModule,
    // Tax engine (pluggable regime: none + eu_vat). Before CartModule
    // so its exported TaxesService + TenantSettingsService are available for
    // cart-totals wiring.
    TaxesModule,
    // Shipping engine (zones + rates). Before CartModule so its exported
    // ShippingService is available for cart-totals wiring + the store rates endpoint.
    ShippingModule,
    // Cart system (Redis + Postgres backstop).
    CartModule,
    // Order state machine. No cart dependency yet; order is fine after CartModule.
    OrdersModule,
    // Legal invoice generation. Listens to `order.paid` (no OrdersModule
    // import — the link is the event), reads order data directly, renders the PDF.
    InvoicesModule,
    // Stripe payment capture (cart payment-intent + webhook source-of-truth →
    // pending_payment→paid → invoice). Imports OrdersModule (load-or-create + transition).
    PaymentsModule,
    // Returns & 14-day withdrawal. Imports OrdersModule + PaymentsModule (RefundService)
    // + CustomersModule. After PaymentsModule so RefundService is available.
    ReturnsModule,
    // Email notifications. Listens for order.created/order.shipped/refund.issued and
    // sends transactional emails via MailService (SMTP/Brevo). Imports OrdersModule + PaymentsModule
    // + InvoicesModule for the template data + resend re-render.
    EmailsModule,
    // Outbound webhook delivery. Fan-out listener → webhook_deliveries
    // outbox → @Cron delivery worker (HMAC-signed, SSRF-guarded, backoff/exhaust). Imports
    // AuthModule for AeadService (signing-secret at rest).
    WebhooksModule,
    // first-boot setup token + boot banner + @Public status/
    // verify-token + SetupTokenGuard (for the 3.2 setup-step endpoints). The boot
    // service mints a one-time token on a not-installed bootstrap.
    SetupModule,
    // admin module install/registry — secure tarball ingest, manifest
    // verification + semver gate, default-deny permission grant, persistence. NO module code
    // runs here (the worker, sandbox, and slots are added later).
    ModulesModule,
    // admin theme install/registry + activation + the public store
    // theme endpoint. Reuses the SHARED hardened tarball extractor (same guards as modules).
    // NO theme code runs (themes are declarative assets). After ModulesModule.
    ThemesModule,
    // admin home-sections CRUD + public store home-sections endpoint.
    // Singleton `sections` JSONB per tenant; validated by the theme-sdk on every write.
    // After ThemesModule (themes:read/write gates are reused for RBAC).
    StorefrontModule,
    // the slot registry — DERIVES the slot → component map
    // from ENABLED modules' declared targets + admin conflict resolutions (admin
    // chooses, no silent override). Admin (resolved + conflicts + pick a winner) + public store
    // map endpoints. After ModulesModule/ThemesModule.
    SlotsModule,
    // admin analytics-settings endpoint. Storefront read piggybacks
    // GET /store/v1/theme (ThemesModule); config lives in tenants.settings via TaxesModule.
    AnalyticsModule,
    HealthModule,
  ],
})
export class AppModule {}
