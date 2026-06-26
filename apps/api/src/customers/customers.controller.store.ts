/**
 * Store Customers Controller (SECURITY-CRITICAL).
 *
 * Routes: /store/v1/customers. The CONTROLLER is NOT class-level @Public — each
 * route declares its own posture so a default can never accidentally open a /me/*
 * route:
 *   - signup / login           — @Public (no token yet), rate-limited login.
 *   - refresh / logout         — @Public + CustomerRefreshGuard (cookie + CSRF).
 *   - me / me/* (profile,
 *     addresses, rgpd)         — @Public + CustomerAuthGuard (the customer token
 *                                gate). @Public here only skips the GLOBAL admin
 *                                guards; CustomerAuthGuard re-imposes customer auth.
 *
 * Every /me/* handler scopes strictly to `customer.id` from the guard-set
 * principal — never a path/body id (no IDOR). The refresh cookie is httpOnly +
 * Secure(prod) + SameSite=Strict + Path=/store/v1/customers (scoped off the admin
 * surface). All login-failure branches collapse to a uniform 401.
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import { RateLimitService } from '../auth/services/rate-limit.service';
import { StoreTenantService } from '../catalog/store-tenant.service';
import { CustomersService } from './customers.service';
import { AddressesService } from './addresses/addresses.service';
import { RgpdService } from './rgpd/rgpd.service';
import { CustomerAuthService } from './auth/customer-auth.service';
import { CustomerPasswordService } from './auth/customer-password.service';
import { CustomerEmailService } from './auth/customer-email.service';
import { CustomerResetService } from './auth/customer-reset.service';
import { CustomerAuthGuard } from './auth/customer-auth.guard';
import { CustomerRefreshGuard, CUSTOMER_REFRESH_COOKIE } from './auth/customer-refresh.guard';
import { CurrentCustomer } from './auth/customer-current.decorator';
import type { AuthenticatedCustomer } from './auth/authenticated-customer';
import { SignupDto } from './dto/signup.dto';
import { CustomerLoginDto } from './dto/customer-login.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';
import { CreateAddressDto, UpdateAddressDto } from './dto/address.dto';
import { RgpdStepUpDto } from './dto/rgpd.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { ChangeEmailDto } from './dto/change-email.dto';
import { ConfirmEmailDto } from './dto/confirm-email.dto';
import { CustomerForgotPasswordDto } from './dto/customer-forgot-password.dto';
import { CustomerResetPasswordDto } from './dto/customer-reset-password.dto';

/** Scope the refresh cookie to the customer surface only (off the admin path). */
const REFRESH_COOKIE_PATH = '/store/v1/customers';
const REFRESH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SIGNUP_RATE_LIMIT = 20;
const SIGNUP_RATE_WINDOW_SECONDS = 60;

interface RequestWithRefresh extends Request {
  refreshToken?: string;
}

@ApiTags('Store / Customers')
@Controller('store/v1/customers')
export class CustomersStoreController {
  constructor(
    private readonly customers: CustomersService,
    private readonly addresses: AddressesService,
    private readonly rgpd: RgpdService,
    private readonly customerAuth: CustomerAuthService,
    private readonly customerPassword: CustomerPasswordService,
    private readonly customerEmail: CustomerEmailService,
    private readonly customerReset: CustomerResetService,
    private readonly storeTenant: StoreTenantService,
    private readonly rateLimit: RateLimitService,
  ) {}

  // ── Public auth surface ─────────────────────────────────────────────────────

  @Public()
  @Post()
  @ApiOperation({ summary: 'Customer self-signup (VIES check if VAT supplied)' })
  async signup(@Body() dto: SignupDto, @Req() req: Request) {
    await this.guardRate(req, 'customer-signup', SIGNUP_RATE_LIMIT);
    const tenantId = await this.storeTenant.getDefaultTenantId();
    return this.customers.signup(tenantId, dto, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Customer login (enumeration-/timing-safe, rate-limited)' })
  async login(
    @Body() dto: CustomerLoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ accessToken: string }> {
    const tenantId = await this.storeTenant.getDefaultTenantId();
    const session = await this.customerAuth.login(tenantId, dto.email, dto.password, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    if (!session) {
      // Uniform 401 across throttled / unknown / no-password / wrong-password.
      throw new UnauthorizedException();
    }
    CustomersStoreController.setRefreshCookie(res, session.refreshToken);
    return { accessToken: session.accessToken };
  }

  @Public()
  @UseGuards(CustomerRefreshGuard)
  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({ summary: 'Rotate the customer session (family rotation + reuse-detection)' })
  async refresh(
    @Req() req: RequestWithRefresh,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ accessToken: string }> {
    const raw = req.refreshToken;
    if (!raw) {
      throw new UnauthorizedException();
    }
    const session = await this.customerAuth.refresh(raw, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    if (!session) {
      CustomersStoreController.clearRefreshCookie(res);
      throw new UnauthorizedException();
    }
    CustomersStoreController.setRefreshCookie(res, session.refreshToken);
    return { accessToken: session.accessToken };
  }

  @Public()
  @UseGuards(CustomerRefreshGuard)
  @Post('logout')
  @HttpCode(204)
  @ApiOperation({ summary: 'Log out (revoke the session family; clear cookie)' })
  async logout(
    @Req() req: RequestWithRefresh,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const raw = req.refreshToken;
    if (raw) {
      await this.customerAuth.logout(raw, { ip: req.ip, userAgent: req.headers['user-agent'] });
    }
    CustomersStoreController.clearRefreshCookie(res);
  }

  // ── Public forgot/reset password ──────────────────

  // Begin a password reset — UNAUTH (no token yet). ALWAYS 202 regardless of whether the
  // email exists (anti-enumeration / timing parity, mirrors the admin POST
  // /auth/password/forgot). Rate-limited per destination-email + per source-IP inside the
  // service (existence-independent gates → 429 on over-cap). The tenant is resolved the
  // SAME way login/signup do (the default-tenant pointer), since the caller is unauth.
  @Public()
  @Post('forgot')
  @HttpCode(202)
  @ApiOperation({ summary: 'Begin a password reset (unauth; enumeration-/timing-safe)' })
  async forgotPassword(
    @Body() dto: CustomerForgotPasswordDto,
    @Req() req: Request,
  ): Promise<{ status: 'accepted' }> {
    const tenantId = await this.storeTenant.getDefaultTenantId();
    await this.customerReset.forgot(tenantId, dto.email, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    // Always 202 regardless of existence.
    return { status: 'accepted' };
  }

  // Complete a password reset — PUBLIC (the single-use token IS the credential, mirroring
  // the admin public POST /auth/reset). NO CustomerAuthGuard. 204 on success; a 400 on an
  // invalid/expired/used token or a weak/breached password (generic — does not say which).
  // A successful reset bumps token_version + revokes ALL refresh families (logout
  // everywhere); it does NOT mint a fresh session (the caller is unauthenticated).
  @Public()
  @Post('reset')
  @HttpCode(204)
  @ApiOperation({ summary: 'Complete a password reset (public; single-use token; logs out all)' })
  async resetPassword(@Body() dto: CustomerResetPasswordDto, @Req() req: Request): Promise<void> {
    await this.customerReset.reset(dto.token, dto.newPassword, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

  // ── Authenticated self-service (CustomerAuthGuard) ──────────────────────────

  @Public()
  @UseGuards(CustomerAuthGuard)
  @Get('me')
  @ApiOperation({ summary: 'Get my profile' })
  me(@CurrentCustomer() customer: AuthenticatedCustomer) {
    return this.customers.getOwnProfile(customer.tenantId, customer.id);
  }

  @Public()
  @UseGuards(CustomerAuthGuard)
  @Patch('me')
  @ApiOperation({ summary: 'Update my profile (VIES re-check if VAT changes)' })
  updateMe(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Body() dto: UpdateCustomerDto,
    @Req() req: Request,
  ) {
    return this.customers.updateOwnProfile(customer.tenantId, customer.id, dto, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

  // Change my password (step-up: current password) — AUTH/CREDENTIAL-CRITICAL.
  // Kills every OTHER session (token_version bump + revoke all refresh families)
  // and KEEPS the current one alive by returning a fresh access token + setting a
  // rotated refresh cookie. Wrong current password / throttle → uniform 401.
  @Public()
  @UseGuards(CustomerAuthGuard)
  @Post('me/password')
  @HttpCode(200)
  @ApiOperation({ summary: 'Change my password (step-up; logs out other sessions)' })
  async changePassword(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Body() dto: ChangePasswordDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ accessToken: string }> {
    const result = await this.customerPassword.changeOwnPassword(
      customer.tenantId,
      customer.id,
      dto.currentPassword,
      dto.newPassword,
      { ip: req.ip, userAgent: req.headers['user-agent'] },
    );
    // Rotate the refresh cookie so the CURRENT session survives the logout-everywhere.
    CustomersStoreController.setRefreshCookie(res, result.refreshToken);
    return { accessToken: result.accessToken };
  }

  // Change my email — verify-before-switch. INITIATE proves
  // the current password (step-up), then emails a single-use link to the NEW address
  // (free target only). The live email is NOT switched here. Uniform 202 whether the
  // target is free or already taken (no account-existence oracle). Wrong password /
  // throttle → uniform 401; newEmail === current → 400.
  @Public()
  @UseGuards(CustomerAuthGuard)
  @Post('me/email/change')
  @HttpCode(202)
  @ApiOperation({ summary: 'Request an email change (step-up; verify-before-switch)' })
  async changeEmail(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Body() dto: ChangeEmailDto,
    @Req() req: Request,
  ): Promise<void> {
    await this.customerEmail.requestEmailChange(
      customer.tenantId,
      customer.id,
      dto.newEmail,
      dto.currentPassword,
      { ip: req.ip, userAgent: req.headers['user-agent'] },
    );
  }

  // Confirm an email change — PUBLIC (the single-use token IS the credential, mirroring
  // the admin public POST /auth/reset). NO CustomerAuthGuard. Atomically consumes the
  // token and swaps the email. invalid/expired/used → 400; target taken since
  // initiate → 409. Does NOT revoke the session (the guard re-reads email each request).
  @Public()
  @Post('me/email/confirm')
  @HttpCode(200)
  @ApiOperation({ summary: 'Confirm an email change (public; single-use token)' })
  async confirmEmail(@Body() dto: ConfirmEmailDto, @Req() req: Request): Promise<void> {
    await this.customerEmail.confirmEmailChange(dto.token, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

  @Public()
  @UseGuards(CustomerAuthGuard)
  @Get('me/addresses')
  @ApiOperation({ summary: 'List my addresses' })
  listAddresses(@CurrentCustomer() customer: AuthenticatedCustomer) {
    return this.addresses.list(customer.tenantId, customer.id);
  }

  @Public()
  @UseGuards(CustomerAuthGuard)
  @Post('me/addresses')
  @ApiOperation({ summary: 'Add an address' })
  createAddress(@CurrentCustomer() customer: AuthenticatedCustomer, @Body() dto: CreateAddressDto) {
    return this.addresses.create(customer.tenantId, customer.id, dto);
  }

  @Public()
  @UseGuards(CustomerAuthGuard)
  @Patch('me/addresses/:id')
  @ApiOperation({ summary: 'Update one of my addresses' })
  updateAddress(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Param('id') id: string,
    @Body() dto: UpdateAddressDto,
  ) {
    return this.addresses.update(customer.tenantId, customer.id, id, dto);
  }

  @Public()
  @UseGuards(CustomerAuthGuard)
  @Delete('me/addresses/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete one of my addresses' })
  deleteAddress(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Param('id') id: string,
  ): Promise<void> {
    return this.addresses.remove(customer.tenantId, customer.id, id);
  }

  // ── RGPD self-service ───────────────────────────────────────────────────────

  // Both RGPD endpoints are STEP-UP-protected (ruling A): they require the
  // customer's current password in the body. Export is a POST (not GET) because it
  // now carries a body. Wrong password → 401, nothing exported/erased.

  @Public()
  @UseGuards(CustomerAuthGuard)
  @Post('me/rgpd/export')
  @HttpCode(200)
  @ApiOperation({ summary: 'Export my data (RGPD Art. 15/20; step-up password)' })
  exportData(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Body() dto: RgpdStepUpDto,
    @Req() req: Request,
  ) {
    return this.rgpd.exportOwnData(customer.tenantId, customer.id, dto.password, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

  @Public()
  @UseGuards(CustomerAuthGuard)
  @Post('me/rgpd/erase')
  @HttpCode(204)
  @ApiOperation({ summary: 'Erase my data (RGPD Art. 17; step-up password; irreversible)' })
  async eraseData(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Body() dto: RgpdStepUpDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.rgpd.eraseSelf(customer.tenantId, customer.id, dto.password, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    // The session is revoked server-side; also clear the cookie at the boundary.
    CustomersStoreController.clearRefreshCookie(res);
  }

  // ── helpers ─────────────────────────────────────────────────────────────────

  private async guardRate(req: Request, bucket: string, limit: number): Promise<void> {
    const ip = req.ip ?? 'unknown';
    const result = await this.rateLimit.check(`${bucket}:${ip}`, {
      limit,
      windowSeconds: SIGNUP_RATE_WINDOW_SECONDS,
    });
    if (!result.allowed) {
      throw new HttpException('Too Many Requests', HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  private static setRefreshCookie(res: Response, value: string): void {
    res.cookie(CUSTOMER_REFRESH_COOKIE, value, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: REFRESH_COOKIE_PATH,
      maxAge: REFRESH_MAX_AGE_MS,
    });
  }

  private static clearRefreshCookie(res: Response): void {
    res.clearCookie(CUSTOMER_REFRESH_COOKIE, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: REFRESH_COOKIE_PATH,
    });
  }
}
