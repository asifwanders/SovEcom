import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { HealthService, HealthCheckResult } from './health.service';
import { Public } from '../auth/decorators/public.decorator';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  // The readiness probe must be reachable without an access token. The global
  // JwtAuthGuard (AuthModule) is fail-closed, so opt this route out explicitly.
  @Public()
  @Get()
  @ApiOperation({ summary: 'Check API health status' })
  @ApiResponse({
    status: 200,
    description: 'All subsystems are healthy',
    type: HealthCheckResult,
  })
  @ApiResponse({
    status: 503,
    description: 'One or more subsystems are down',
  })
  async check(): Promise<HealthCheckResult> {
    const result = await this.healthService.check();
    if (result.status !== 'ok') {
      // 503 — readiness failure; the body still carries the per-subsystem detail.
      throw new ServiceUnavailableException(result);
    }
    return result;
  }
}
