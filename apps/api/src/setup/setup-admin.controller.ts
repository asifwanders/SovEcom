/**
 * SetupAdminController (THE MOST SECURITY-CRITICAL routes).
 *
 * The owner-credential email-OTP flow + the final install flip, under `/setup/v1`. EVERY
 * route carries BOTH `@Public()` (so the global fail-closed JwtAuthGuard/PermissionsGuard
 * SKIP it — there is no admin JWT during setup) AND `@UseGuards(SetupTokenGuard)` (the
 * POSITIVE gate: a live `X-Setup-Token` on a not-installed system, else 404). Same
 * combination as the other setup controllers.
 *
 *   POST admin-account/start  {email,name}      → {sent:true}   (sends OTP; never the OTP)
 *   POST admin-account/verify {email,otp,pwd}   → {ok:true}     (sets the owner password)
 *   POST complete                               → {installed:true} (consume token + flip)
 *
 * Zod DTOs validate every body. The OTP + password are never logged or echoed. The
 * `/complete` route reads the SAME `X-Setup-Token` header the guard validated and passes
 * the plaintext to the service for the atomic consume-and-flip. A precondition failure
 * (admin/tax not done) maps to a 422 listing what is missing — never a credential oracle.
 */
import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  Req,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../auth/decorators/public.decorator';
import { SetupTokenGuard } from './guards/setup-token.guard';
import { SetupStateService } from './setup-state.service';
import { SetupAdminService } from './setup-admin.service';
import { SetupInstallService, SetupPreconditionError } from './setup-install.service';
import { AdminAccountStartDto, AdminAccountVerifyDto } from './dto/admin-account.dto';

@Controller('setup/v1')
export class SetupAdminController {
  constructor(
    private readonly state: SetupStateService,
    private readonly admin: SetupAdminService,
    private readonly install: SetupInstallService,
  ) {}

  // ─── admin-account/start (send the OTP) ────────────────────────────────────────

  @Public()
  @UseGuards(SetupTokenGuard)
  @Post('admin-account/start')
  @HttpCode(200)
  async adminStart(
    @Body() dto: AdminAccountStartDto,
    @Req() req: Request,
  ): Promise<{ sent: true }> {
    const tenantId = await this.state.getDefaultTenantId();
    return this.admin.start(tenantId, dto, { ip: req.ip });
  }

  // ─── admin-account/verify (set the owner credential) ───────────────────────────

  @Public()
  @UseGuards(SetupTokenGuard)
  @Post('admin-account/verify')
  @HttpCode(200)
  async adminVerify(
    @Body() dto: AdminAccountVerifyDto,
    @Req() req: Request,
  ): Promise<{ ok: true }> {
    const tenantId = await this.state.getDefaultTenantId();
    return this.admin.verify(tenantId, dto, { ip: req.ip });
  }

  // ─── complete (consume token + flip installed) ─────────────────────────────────

  @Public()
  @UseGuards(SetupTokenGuard)
  @Post('complete')
  @HttpCode(200)
  async complete(
    @Headers('x-setup-token') token: string | undefined,
  ): Promise<{ installed: true }> {
    const tenantId = await this.state.getDefaultTenantId();
    try {
      // The guard already validated this same header; pass the plaintext to the service
      // for the atomic consume-and-flip. (Defensive empty check — the guard ensures it.)
      return await this.install.complete(tenantId, token ?? '');
    } catch (err) {
      if (err instanceof SetupPreconditionError) {
        // 422 listing the unmet prerequisites — NOT a credential oracle.
        throw new UnprocessableEntityException({
          message: 'setup is not complete',
          missing: err.missing,
        });
      }
      throw err;
    }
  }
}
