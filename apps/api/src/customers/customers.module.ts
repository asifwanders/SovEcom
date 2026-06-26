/**
 * CustomersModule (SECURITY-CRITICAL: second auth system + RGPD/PII).
 *
 * Wires the customer CRUD (admin), self-service storefront auth + profile +
 * addresses, RGPD export/erase, and VIES VAT validation. Imports:
 *   - AuthModule  → PasswordService, RateLimitService, TokenService (exported) +
 *                   the GLOBAL admin JwtAuthGuard/PermissionsGuard still apply to
 *                   /admin/* and to /store/* (which opts out via @Public).
 *   - CatalogModule → StoreTenantService (default-tenant resolution for store).
 * DatabaseService, RedisService, AuditService are @Global (no explicit import).
 *
 * CustomerTokenService uses a factory (its ctor takes a ConfigService-shaped seam,
 * like the admin TokenService). The VIES client is bound to the {@link VIES_CLIENT}
 * token with the real-client stub; tests OVERRIDE this provider with a mock so no
 * network egress happens in CI.
 */
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AuthModule } from '../auth/auth.module';
import { CatalogModule } from '../catalog/catalog.module';
import { TaxesModule } from '../taxes/taxes.module';
import { CustomersAdminController } from './customers.controller.admin';
import { CustomersStoreController } from './customers.controller.store';
import { CustomersService } from './customers.service';
import { CustomersRepository } from './customers.repository';
import { AddressesService } from './addresses/addresses.service';
import { AddressesRepository } from './addresses/addresses.repository';
import { RgpdService } from './rgpd/rgpd.service';
import { CustomerAuthService } from './auth/customer-auth.service';
import { CustomerPasswordService } from './auth/customer-password.service';
import { CustomerEmailService } from './auth/customer-email.service';
import { CustomerResetService } from './auth/customer-reset.service';
import { TokenRetentionSweeperService } from './auth/token-retention-sweeper.service';
import { CustomerAuthGuard } from './auth/customer-auth.guard';
import { CustomerRefreshGuard } from './auth/customer-refresh.guard';
import { CustomerTokenService } from './auth/customer-token.service';
import { ViesService } from './vies/vies.service';
import { VIES_CLIENT, RealViesClient } from './vies/vies.client';

@Module({
  // ScheduleModule.forRoot() registers the @Cron metadata scanner for this module's
  // TokenRetentionSweeperService (F10). Safe alongside the other call sites (inventory,
  // cart, …): @nestjs/schedule@6 `forRoot()` returns a dynamic module with `global: true`,
  // and Nest DEDUPES identical global dynamic modules — so all call sites collapse to ONE
  // ScheduleExplorer and each @Cron fires exactly once (verified F1).
  imports: [AuthModule, CatalogModule, TaxesModule, ScheduleModule.forRoot()],
  controllers: [CustomersAdminController, CustomersStoreController],
  providers: [
    CustomersService,
    CustomersRepository,
    AddressesService,
    AddressesRepository,
    RgpdService,
    CustomerAuthService,
    CustomerPasswordService,
    CustomerEmailService,
    CustomerResetService,
    TokenRetentionSweeperService,
    CustomerAuthGuard,
    CustomerRefreshGuard,
    ViesService,
    // CustomerTokenService reads JWT_SECRET via a ConfigService-shaped seam.
    {
      provide: CustomerTokenService,
      useFactory: (config: ConfigService): CustomerTokenService => new CustomerTokenService(config),
      inject: [ConfigService],
    },
    // VIES client seam: real stub in prod; tests override this token with a mock.
    { provide: VIES_CLIENT, useClass: RealViesClient },
  ],
  exports: [CustomersService, CustomerAuthService, CustomerTokenService, CustomersRepository],
})
export class CustomersModule {}
