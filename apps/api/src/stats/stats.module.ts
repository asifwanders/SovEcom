/**
 * StatsModule — admin dashboard aggregates.
 *
 * DatabaseService is @Global (no import needed here).
 * TaxesModule exports TenantSettingsService (for currency resolution).
 */
import { Module } from '@nestjs/common';
import { TaxesModule } from '../taxes/taxes.module';
import { StatsRepository } from './stats.repository';
import { StatsService } from './stats.service';
import { StatsAdminController } from './stats.controller.admin';

@Module({
  imports: [TaxesModule],
  providers: [StatsRepository, StatsService],
  controllers: [StatsAdminController],
})
export class StatsModule {}
