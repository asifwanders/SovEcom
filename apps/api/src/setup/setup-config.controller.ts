/**
 * SetupConfigController (SECURITY-CRITICAL).
 *
 * The database / smtp / payments setup-step endpoints under `/setup/v1`. EVERY route
 * carries BOTH:
 *   - `@Public()`        — so the global fail-closed JwtAuthGuard/PermissionsGuard SKIP
 *                          it (there is no admin JWT during setup), AND
 *   - `@UseGuards(SetupTokenGuard)` — the POSITIVE gate: a live `X-Setup-Token` on a
 *                          not-installed system, else 404 (post-install lockdown / bad
 *                          token both hide the surface).
 * Nothing else is loosened. Zod DTOs validate (and bound) every body. No endpoint ever
 * returns or logs a submitted/persisted credential — test endpoints return only
 * `{ok}`/sanitized-error, configure endpoints return only `{ok}`/non-secret verdicts.
 */
import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator';
import { SetupTokenGuard } from './guards/setup-token.guard';
import { SetupStateService } from './setup-state.service';
import { SetupConfigService, type ProbeResult } from './setup-config.service';
import { DatabaseTestDto, DatabaseConfigureDto } from './dto/database.dto';
import { SmtpTestDto, SmtpConfigureDto } from './dto/smtp.dto';
import { PaymentsConfigureDto } from './dto/payments.dto';

@Controller('setup/v1')
export class SetupConfigController {
  constructor(
    private readonly state: SetupStateService,
    private readonly config: SetupConfigService,
  ) {}

  // ─── database ──────────────────────────────────────────────────────────────

  @Public()
  @UseGuards(SetupTokenGuard)
  @Post('database/test')
  @HttpCode(200)
  async databaseTest(@Body() dto: DatabaseTestDto): Promise<ProbeResult> {
    return this.config.testDatabase(dto.url);
  }

  @Public()
  @UseGuards(SetupTokenGuard)
  @Post('database/configure')
  @HttpCode(200)
  async databaseConfigure(@Body() dto: DatabaseConfigureDto): Promise<{ ok: true }> {
    await this.config.configureDatabase(dto);
    return { ok: true };
  }

  // ─── smtp ──────────────────────────────────────────────────────────────────

  @Public()
  @UseGuards(SetupTokenGuard)
  @Post('smtp/test')
  @HttpCode(200)
  async smtpTest(@Body() dto: SmtpTestDto): Promise<ProbeResult> {
    return this.config.testSmtp(dto);
  }

  @Public()
  @UseGuards(SetupTokenGuard)
  @Post('smtp/configure')
  @HttpCode(200)
  async smtpConfigure(@Body() dto: SmtpConfigureDto): Promise<{ ok: true }> {
    const tenantId = await this.state.getDefaultTenantId();
    await this.config.configureSmtp(tenantId, dto);
    return { ok: true };
  }

  // ─── payments ────────────────────────────────────────────────────────────────

  @Public()
  @UseGuards(SetupTokenGuard)
  @Post('payments/configure')
  @HttpCode(200)
  async paymentsConfigure(
    @Body() dto: PaymentsConfigureDto,
  ): Promise<{ ok: true; stripe?: 'valid' | 'invalid' | 'unvalidated' }> {
    const tenantId = await this.state.getDefaultTenantId();
    const result = await this.config.configurePayments(tenantId, dto);
    return { ok: true, ...result };
  }
}
