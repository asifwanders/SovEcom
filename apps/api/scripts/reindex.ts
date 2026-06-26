/**
 * Reindex script.
 *
 * Usage:
 *   pnpm --filter @sovecom/api reindex -- --tenant <tenantId>
 *   pnpm --filter @sovecom/api reindex -- --all
 *
 * Bootstraps a minimal NestJS context (DatabaseModule + SearchModule), then calls
 * ProductIndexer.reindexTenant() which drops+recreates the index and bulk-upserts
 * all published products. Idempotent — safe to run multiple times for drift recovery.
 *
 * Requires the same env vars as the running API:
 *   DATABASE_URL, MEILISEARCH_URL, MEILI_MASTER_KEY
 * Plus storage env if thumbnailUrl generation is needed:
 *   S3_ENDPOINT (or LOCAL_STORAGE_PATH), etc.
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { DatabaseModule } from '../src/database/database.module';
import { RedisModule } from '../src/redis/redis.module';
import { StorageModule } from '../src/storage/storage.module';
import { SearchModule } from '../src/search/search.module';
import { AuthModule } from '../src/auth/auth.module';
import { CatalogModule } from '../src/catalog/catalog.module';
import { AuditModule } from '../src/audit/audit.module';
import { ProductIndexer } from '../src/search/indexers/product.indexer';
import { DatabaseService } from '../src/database/database.service';
import { tenants } from '../src/database/schema/_tenants';

// ── Bootstrap a slim app for the reindex task ─────────────────────────────────

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    EventEmitterModule.forRoot(),
    DatabaseModule,
    RedisModule,
    StorageModule,
    AuditModule,
    AuthModule,
    CatalogModule,
    SearchModule,
  ],
})
class ReindexAppModule {}

async function main() {
  // Parse CLI args.
  const args = process.argv.slice(2);
  const tenantArg = args.find((_, i) => args[i - 1] === '--tenant');
  const allFlag = args.includes('--all');

  if (!tenantArg && !allFlag) {
    console.error('Usage: reindex -- --tenant <id>  OR  reindex -- --all');
    process.exit(1);
  }

  // Ensure required env is present.
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }

  // Pin test-safe values for secrets if running in test/local context.
  process.env.JWT_SECRET ??= 'reindex-script-jwt-placeholder';
  process.env.MASTER_KEY ??= Buffer.alloc(32, 0x2a).toString('base64');
  process.env.STORAGE_SIGNING_SECRET ??= 'reindex-script-placeholder';

  const app = await NestFactory.createApplicationContext(ReindexAppModule, {
    logger: ['error', 'warn', 'log'],
  });

  const indexer = app.get(ProductIndexer);

  let tenantIds: string[] = [];
  if (tenantArg) {
    tenantIds = [tenantArg];
  } else {
    // --all: fetch every tenant from the DB.
    const db = app.get(DatabaseService);
    const rows = await db.db.select({ id: tenants.id }).from(tenants);
    tenantIds = rows.map((r) => r.id);
  }

  let totalIndexed = 0;
  for (const tid of tenantIds) {
    console.log(`[reindex] tenant=${tid} starting…`);
    const { indexed } = await indexer.reindexTenant(tid);
    console.log(`[reindex] tenant=${tid} indexed=${indexed} ✓`);
    totalIndexed += indexed;
  }

  console.log(
    `[reindex] done — total indexed=${totalIndexed} across ${tenantIds.length} tenant(s)`,
  );
  await app.close();
}

main().catch((err) => {
  console.error('[reindex] fatal error:', err);
  process.exit(1);
});
