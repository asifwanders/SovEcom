/**
 * StorageModule.
 *
 * Reads `STORAGE_DRIVER` env ('local' | 's3', default 'local') and provides
 * the corresponding adapter under the `STORAGE_ADAPTER` token.
 *
 * Marked `@Global()` so any module can inject `StorageService` without
 * importing `StorageModule` directly (mirrors the pattern used by RedisModule,
 * MailModule, etc.).
 */
import { Global, Module, Provider } from '@nestjs/common';
import { LocalAdapter } from './adapters/local.adapter';
import { S3Adapter } from './adapters/s3.adapter';
import { StorageService, STORAGE_ADAPTER } from './storage.service';
import { StorageController } from './storage.controller';

const storageAdapterProvider: Provider = {
  provide: STORAGE_ADAPTER,
  useFactory: () => {
    const driver = process.env['STORAGE_DRIVER'] ?? 'local';
    if (driver === 's3') return new S3Adapter();
    return new LocalAdapter();
  },
};

@Global()
@Module({
  providers: [storageAdapterProvider, StorageService],
  controllers: [StorageController],
  exports: [StorageService, STORAGE_ADAPTER],
})
export class StorageModule {}
