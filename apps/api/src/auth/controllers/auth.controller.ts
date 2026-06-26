/**
 * AuthController (SECURITY-CRITICAL).
 *
 * `/admin/v1/auth/*`. Public routes (`login`, `2fa`) carry the `@Public()` Symbol
 * marker; `refresh`/`logout` are guarded by {@link JwtRefreshGuard} (cookie +
 * Origin check); the rest sit behind the global {@link JwtAuthGuard}.
 *
 * The refresh cookie is set httpOnly + Secure(prod) + SameSite=Strict +
 * Path=/admin/v1/auth. All four login-failure branches collapse to a
 * single uniform 401 (anti-enumeration). NO secret is ever logged.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { and, eq } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import { users, type User } from '../../database/schema/users';
import { AuthService } from '../services/auth.service';
import { TwoFactorEnrollmentService } from '../services/two-factor-enrollment.service';
import { JwtRefreshGuard, REFRESH_COOKIE } from '../guards/jwt-refresh.guard';
import { Public } from '../decorators/public.decorator';
import { AnyAuthenticated } from '../../authorization/decorators/any-authenticated.decorator';
import { CurrentUser } from '../decorators/current-user.decorator';
import type { AuthenticatedUser } from '../authenticated-user';
import { LoginDto } from '../dto/login.dto';
import { Verify2faDto } from '../dto/verify-2fa.dto';
import { Confirm2faDto } from '../dto/confirm-2fa.dto';
import { Disable2faDto } from '../dto/disable-2fa.dto';

/** Cookie path scopes the refresh token to the auth surface only. */
const REFRESH_COOKIE_PATH = '/admin/v1/auth';
const REFRESH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

interface RequestWithRefresh extends Request {
  refreshToken?: string;
}

@Controller('admin/v1/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly enrollment: TwoFactorEnrollmentService,
    private readonly database: DatabaseService,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ requires2FA: true; challengeId: string } | { accessToken: string }> {
    const ctx = AuthController.ctx(req);
    const result = await this.auth.login(dto.email, dto.password, ctx);
    if (!result) {
      // Uniform 401 across missing / locked / wrong-pw / throttled.
      throw new UnauthorizedException();
    }
    if (result.requires2FA) {
      return { requires2FA: true, challengeId: result.challengeId };
    }
    AuthController.setRefreshCookie(res, result.refreshToken);
    return { accessToken: result.accessToken };
  }

  @Public()
  @Post('2fa')
  @HttpCode(200)
  async verify2fa(
    @Body() dto: Verify2faDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ accessToken: string }> {
    const ctx = AuthController.ctx(req);
    const result = await this.auth.verify2fa(dto.challengeId, dto.totpCode, ctx);
    if (!result) {
      throw new UnauthorizedException();
    }
    AuthController.setRefreshCookie(res, result.refreshToken);
    return { accessToken: result.accessToken };
  }

  @Public()
  @UseGuards(JwtRefreshGuard)
  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Req() req: RequestWithRefresh,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ accessToken: string }> {
    const ctx = AuthController.ctx(req);
    const raw = req.refreshToken;
    if (!raw) {
      throw new UnauthorizedException();
    }
    const result = await this.auth.refresh(raw, ctx);
    if (!result) {
      AuthController.clearRefreshCookie(res);
      throw new UnauthorizedException();
    }
    AuthController.setRefreshCookie(res, result.refreshToken);
    return { accessToken: result.accessToken };
  }

  @Public()
  @UseGuards(JwtRefreshGuard)
  @Post('logout')
  @HttpCode(204)
  async logout(
    @Req() req: RequestWithRefresh,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const ctx = AuthController.ctx(req);
    const raw = req.refreshToken;
    if (raw) {
      await this.auth.logout(raw, ctx);
    }
    AuthController.clearRefreshCookie(res);
  }

  @AnyAuthenticated()
  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser): {
    id: string;
    email: string;
    name: string;
    role: string;
    totpEnabled: boolean;
  } {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      totpEnabled: user.totpEnabled,
    };
  }

  @AnyAuthenticated()
  @Post('2fa/enroll')
  @HttpCode(200)
  async enroll2fa(
    @CurrentUser() principal: AuthenticatedUser,
    @Req() req: Request,
  ): Promise<{ secret: string; otpauthUrl: string; qrDataUrl: string }> {
    const user = await this.loadUser(principal);
    return this.enrollment.enroll(user, AuthController.ctx(req));
  }

  @AnyAuthenticated()
  @Post('2fa/confirm')
  @HttpCode(204)
  async confirm2fa(
    @CurrentUser() principal: AuthenticatedUser,
    @Body() dto: Confirm2faDto,
    @Req() req: Request,
  ): Promise<void> {
    const user = await this.loadUser(principal);
    const ok = await this.enrollment.confirm(user, dto.totpCode, AuthController.ctx(req));
    if (!ok) {
      throw new BadRequestException('invalid code');
    }
  }

  @AnyAuthenticated()
  @Post('2fa/disable')
  @HttpCode(204)
  async disable2fa(
    @CurrentUser() principal: AuthenticatedUser,
    @Body() dto: Disable2faDto,
    @Req() req: Request,
  ): Promise<void> {
    const user = await this.loadUser(principal);
    const ok = await this.enrollment.disable(
      user,
      dto.password,
      dto.totpCode,
      AuthController.ctx(req),
    );
    if (!ok) {
      throw new BadRequestException('invalid credentials');
    }
  }

  /** Re-load the full user ROW (the principal carries no secrets). */
  private async loadUser(principal: AuthenticatedUser): Promise<User> {
    const [user] = await this.database.db
      .select()
      .from(users)
      .where(and(eq(users.id, principal.id), eq(users.tenantId, principal.tenantId)))
      .limit(1);
    if (!user) {
      throw new UnauthorizedException();
    }
    return user;
  }

  private static ctx(req: Request): { ip?: string; userAgent?: string } {
    return { ip: req.ip, userAgent: req.headers['user-agent'] };
  }

  private static setRefreshCookie(res: Response, value: string): void {
    res.cookie(REFRESH_COOKIE, value, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: REFRESH_COOKIE_PATH,
      maxAge: REFRESH_MAX_AGE_MS,
    });
  }

  private static clearRefreshCookie(res: Response): void {
    res.clearCookie(REFRESH_COOKIE, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: REFRESH_COOKIE_PATH,
    });
  }
}
