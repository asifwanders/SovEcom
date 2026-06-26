/**
 * AuthModule (SECURITY-CRITICAL).
 *
 * Wires the auth services, controllers, guards and decorators. Registers
 * {@link JwtAuthGuard} GLOBALLY via `APP_GUARD` so every route is fail-closed
 * unless it carries the `@Public()` Symbol marker.
 *
 * `DatabaseService`, `RedisService`, `AuditService` and the mail seam are global
 * providers (their modules are `@Global`), so they inject without explicit
 * imports. `TokenService` and `TwoFactorService` use factory providers because
 * their ctors take a config-shaped seam / positional (redis, aead) seam rather
 * than nest-injectable class tokens — matching the unit-test construction.
 */
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../redis/redis.service';
import { AuthController } from './controllers/auth.controller';
import { PasswordController } from './controllers/password.controller';
import { AuthService } from './services/auth.service';
import { ResetService } from './services/reset.service';
import { TokenService } from './services/token.service';
import { PasswordService } from './services/password.service';
import { TwoFactorService } from './services/two-factor.service';
import { TwoFactorEnrollmentService } from './services/two-factor-enrollment.service';
import { ChallengeService } from './services/challenge.service';
import { RateLimitService } from './services/rate-limit.service';
import { AeadService } from './crypto/aead.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { JwtRefreshGuard } from './guards/jwt-refresh.guard';

@Module({
  controllers: [AuthController, PasswordController],
  providers: [
    AuthService,
    ResetService,
    PasswordService,
    ChallengeService,
    RateLimitService,
    TwoFactorEnrollmentService,
    JwtRefreshGuard,
    // AeadService's ctor takes an OPTIONAL raw-key seam (`key?: Buffer`). Nest's
    // DI does not honour the TS `?` — a bare class provider makes it try to
    // inject a `Buffer` token and fail to boot. Construct it explicitly with no
    // argument so it loads the master key from MASTER_KEY / `/data/master.key`.
    {
      provide: AeadService,
      useFactory: (): AeadService => new AeadService(),
    },
    // TokenService reads JWT_SECRET via a ConfigService-shaped seam.
    {
      provide: TokenService,
      useFactory: (config: ConfigService): TokenService => new TokenService(config),
      inject: [ConfigService],
    },
    // TwoFactorService takes (redisLike, aeadLike) positionally.
    {
      provide: TwoFactorService,
      useFactory: (redis: RedisService, aead: AeadService): TwoFactorService =>
        new TwoFactorService(redis.client, aead),
      inject: [RedisService, AeadService],
    },
    // Global, fail-closed access-token guard.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
  // AeadService exported: the generic AES-256-GCM secret-at-rest
  // service is reused by WebhooksModule to encrypt subscription signing secrets.
  exports: [AuthService, TokenService, RateLimitService, PasswordService, AeadService],
})
export class AuthModule {}
