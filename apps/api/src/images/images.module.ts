/**
 * ImagesModule.
 *
 * StorageService is @Global (StorageModule) — no import needed.
 * DatabaseService is @Global (DatabaseModule) — no import needed.
 */
import { Module } from '@nestjs/common';
import { SharpProcessor } from './processors/sharp.processor';
import { ImagesService } from './images.service';
import { ImagesController } from './controllers/images.controller';

@Module({
  providers: [SharpProcessor, ImagesService],
  controllers: [ImagesController],
})
export class ImagesModule {}
