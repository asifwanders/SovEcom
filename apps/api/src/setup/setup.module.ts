/**
 * SetupModule (SECURITY-CRITICAL).
 *
 * Wires the first-boot setup-token flow:
 *   - SetupTokenService  — generate / supersede / verify / consume (SHA-256).
 *   - SetupStateService  — read the global `system_state.installed` flag.
 *   - SetupBootService   — OnApplicationBootstrap banner + token mint.
 *     Runs on app bootstrap (suppressed under NODE_ENV=test).
 *   - SetupController     — @Public() GET /status + POST /verify-token.
 *   - SetupTokenGuard     — provided + EXPORTED for the setup-step routes.
 *
 * Imports AuthModule for the exported {@link RateLimitService} (verify-token
 * throttle). DatabaseService / RedisService are @Global, so they inject without an
 * explicit import.
 */
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TaxesModule } from '../taxes/taxes.module';
import { ViesService } from '../customers/vies/vies.service';
import { VIES_CLIENT, RealViesClient } from '../customers/vies/vies.client';
import { ThemesModule } from '../modules/themes.module';
import { ModulesModule } from '../modules/modules.module';
import { SetupController } from './setup.controller';
import { SetupConfigController } from './setup-config.controller';
import { SetupOnboardingController } from './setup-onboarding.controller';
import { SetupAdminController } from './setup-admin.controller';
import { SetupTokenService } from './setup-token.service';
import { SetupStateService } from './setup-state.service';
import { SetupSecretsService } from './setup-secrets.service';
import { SetupConfigService } from './setup-config.service';
import { SetupOnboardingService } from './setup-onboarding.service';
import { SetupAdminService } from './setup-admin.service';
import { SetupInstallService } from './setup-install.service';
import { SetupBootService } from './setup-boot.service';
import { SetupTokenGuard } from './guards/setup-token.guard';

/**
 * Provides the full setup-wizard pipeline: config/onboarding/admin/complete endpoints
 * behind SetupTokenGuard + @Public, secrets persistence (AEAD-encrypted at rest),
 * connection/transport probes, tax/compliance/brand configuration, themes list/activate,
 * bundled-modules list/install, owner-credential email-OTP flow, and atomic install flip.
 *
 * TaxesModule supplies TenantSettingsService; ViesService + VIES_CLIENT are provided
 * here; AuthModule supplies AeadService, RateLimitService, PasswordService; MailModule
 * (@Global) supplies MAIL_SERVICE; ThemesModule/ModulesModule supply their services;
 * DatabaseService/StorageService/RedisService are @Global (no import needed).
 */
@Module({
  // ViesService is provided here so tax/configure can VIES-validate the merchant VAT number;
  // tests can OVERRIDE the VIES_CLIENT token with a mock.
  imports: [AuthModule, TaxesModule, ThemesModule, ModulesModule],
  controllers: [
    SetupController,
    SetupConfigController,
    SetupOnboardingController,
    SetupAdminController,
  ],
  providers: [
    SetupTokenService,
    SetupStateService,
    SetupSecretsService,
    SetupConfigService,
    SetupOnboardingService,
    SetupAdminService,
    SetupInstallService,
    SetupBootService,
    SetupTokenGuard,
    ViesService,
    { provide: VIES_CLIENT, useClass: RealViesClient },
  ],
  // SetupTokenGuard + the services are exported so downstream modules can gate routes,
  // persist secrets, and run consume + install logic.
  exports: [SetupTokenService, SetupStateService, SetupSecretsService, SetupTokenGuard],
})
export class SetupModule {}
