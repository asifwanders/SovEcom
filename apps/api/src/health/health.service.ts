import { Injectable } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import { DatabaseService } from '../database/database.service';
import { RedisService } from '../redis/redis.service';
import { SearchService } from '../search/search.service';
import { StorageService } from '../storage/storage.service';

export type SubsystemStatus = 'ok' | 'down';

export class HealthCheckResult {
  @ApiProperty({ example: 'ok', enum: ['ok', 'error'] })
  status!: 'ok' | 'error';

  @ApiProperty({ example: 42.5, description: 'Process uptime in seconds' })
  uptime!: number;

  @ApiProperty({ example: 'ok', enum: ['ok', 'down'] })
  postgres!: SubsystemStatus;

  @ApiProperty({ example: 'ok', enum: ['ok', 'down'] })
  redis!: SubsystemStatus;

  @ApiProperty({ example: 'ok', enum: ['ok', 'down'] })
  meilisearch!: SubsystemStatus;

  @ApiProperty({ example: 'ok', enum: ['ok', 'down'] })
  storage!: SubsystemStatus;
}

@Injectable()
export class HealthService {
  constructor(
    private readonly database: DatabaseService,
    private readonly redis: RedisService,
    private readonly search: SearchService,
    private readonly storageService: StorageService,
  ) {}

  async check(): Promise<HealthCheckResult> {
    const [pg, rd, ms, st] = await Promise.all([
      this.database.ping(),
      this.redis.ping(),
      this.search.ping(),
      this.storageService.healthProbe(),
    ]);

    const postgres: SubsystemStatus = pg ? 'ok' : 'down';
    const redis: SubsystemStatus = rd ? 'ok' : 'down';
    const meilisearch: SubsystemStatus = ms ? 'ok' : 'down';
    const storage: SubsystemStatus = st.ok ? 'ok' : 'down';
    const allOk = pg && rd && ms && st.ok;

    return {
      status: allOk ? 'ok' : 'error',
      uptime: process.uptime(),
      postgres,
      redis,
      meilisearch,
      storage,
    };
  }
}
