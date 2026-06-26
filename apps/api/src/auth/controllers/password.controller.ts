/**
 * PasswordController (SECURITY-CRITICAL).
 *
 * `/admin/v1/auth/password/*`. Both routes are `@Public()`.
 *   forgot: ALWAYS 202 (anti-enumeration / timing parity) — never reveals whether
 *     the email exists.
 *   reset: 204 on success; a 400 on an invalid/expired/used token or a policy
 *     violation (generic — does not say which).
 *
 * The reset token / URL are never logged.
 */
import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ResetService } from '../services/reset.service';
import { Public } from '../decorators/public.decorator';
import { ForgotPasswordDto } from '../dto/forgot-password.dto';
import { ResetPasswordDto } from '../dto/reset-password.dto';

@Controller('admin/v1/auth/password')
export class PasswordController {
  constructor(private readonly reset: ResetService) {}

  @Public()
  @Post('forgot')
  @HttpCode(202)
  async forgot(
    @Body() dto: ForgotPasswordDto,
    @Req() req: Request,
  ): Promise<{ status: 'accepted' }> {
    await this.reset.forgot(dto.email, { ip: req.ip, userAgent: req.headers['user-agent'] });
    // Always 202 regardless of existence.
    return { status: 'accepted' };
  }

  @Public()
  @Post('reset')
  @HttpCode(204)
  async resetPassword(@Body() dto: ResetPasswordDto, @Req() req: Request): Promise<void> {
    await this.reset.reset(dto.token, dto.newPassword, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }
}
