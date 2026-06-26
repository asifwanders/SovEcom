/**
 * CartFlushRepository.
 *
 * The Postgres-flush + cleanup half of the cart persistence layer, split out of
 * CartRepository to keep each file focused (and under the line budget). Drains
 * the per-tenant Redis dirty set to Postgres, discovers tenants to flush, and
 * runs the daily expired-cart cleanup. Delegates the actual read + upsert to
 * CartRepository so both the synchronous `persist()` path and this async flush
 * share ONE idempotent write path.
 */
import { Injectable, Logger } from '@nestjs/common';
import { and, eq, lt } from 'drizzle-orm';
import { RedisService, keys } from '../redis/redis.service';
import { DatabaseService } from '../database/database.service';
import { carts } from '../database/schema/carts';
import { CartRepository, reviveCartState } from './cart.repository';

@Injectable()
export class CartFlushRepository {
  private readonly logger = new Logger(CartFlushRepository.name);

  constructor(
    private readonly redis: RedisService,
    private readonly db: DatabaseService,
    private readonly carts: CartRepository,
  ) {}

  /**
   * Drain the dirty-set for a tenant and upsert each cart to Postgres.
   * Returns the number of carts flushed.
   */
  async flushDirty(tenantId: string): Promise<number> {
    const dirtyKey = keys.cartDirty(tenantId);
    const cartIds = await this.redis.client.smembers(dirtyKey);
    if (cartIds.length === 0) return 0;

    let flushed = 0;
    for (const cartId of cartIds) {
      try {
        const state = await this.carts.findById(tenantId, cartId);
        if (!state) {
          // Stale entry — remove from dirty set
          await this.redis.client.srem(dirtyKey, cartId);
          continue;
        }
        // Snapshot the version we are about to flush. A concurrent mutate() may
        // SETEX a newer blob (and re-SADD the dirty flag) between this read and
        // the SREM below.
        const flushedUpdatedAt = state.updatedAt.getTime();
        await this.carts.upsertToPostgres(state);
        // S3 dirty-set race fix: only clear the dirty flag if the
        // CURRENT Redis state is still the one we just flushed. If a write landed
        // in between (newer updatedAt, or the key was evicted), LEAVE the flag so
        // that newer state is flushed on the next pass — never silently dropped.
        const current = await this.redis.client.get(keys.cart(tenantId, cartId));
        let stillCurrent = false;
        if (current) {
          try {
            const parsed = reviveCartState(JSON.parse(current) as unknown);
            stillCurrent = parsed.updatedAt.getTime() === flushedUpdatedAt;
          } catch {
            stillCurrent = false; // corrupt → leave dirty for a clean retry
          }
        }
        if (stillCurrent) {
          await this.redis.client.srem(dirtyKey, cartId);
        }
        flushed++;
      } catch (err) {
        // Isolate a poisoned cart: log it and LEAVE it in the dirty set for a
        // later retry, but never let it abort the rest of this tenant's flush
        // (or, via the caller, other tenants). The known permanent-poison vectors
        // (zero-quantity merge lines, deleted-variant FK violations, RGPD-erased
        // customer FK) are removed at the source, so a failure here is transient.
        this.logger.error(
          `cart flush failed for ${cartId} (tenant ${tenantId}); left dirty for retry`,
          err instanceof Error ? err.stack : String(err),
        );
      }
    }
    return flushed;
  }

  /** Daily cleanup: delete Postgres carts older than 30 days. */
  async deleteExpiredCarts(tenantId: string): Promise<number> {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const deleted = await this.db.db
      .delete(carts)
      .where(and(eq(carts.tenantId, tenantId), lt(carts.expiresAt, cutoff)))
      .returning({ id: carts.id });
    return deleted.length;
  }

  /**
   * Tenants that currently have a dirty set in Redis — discovered by SCANning
   * `sovecom:t:*:cart:dirty`. The flush worker MUST use this (not the Postgres
   * carts table): a freshly-created cart lives only in Redis until it is flushed,
   * so the carts table is empty for it. Querying Postgres would never surface a
   * never-yet-persisted cart — the exact carts that need flushing.
   */
  async getDirtyTenantIds(): Promise<string[]> {
    const found = new Set<string>();
    let cursor = '0';
    do {
      const [next, batch] = await this.redis.client.scan(
        cursor,
        'MATCH',
        'sovecom:t:*:cart:dirty',
        'COUNT',
        100,
      );
      cursor = next;
      for (const key of batch) {
        // sovecom:t:{tenantId}:cart:dirty — tenantId is segment index 2.
        const parts = key.split(':');
        if (parts.length === 5 && parts[3] === 'cart' && parts[4] === 'dirty') {
          found.add(parts[2]!);
        }
      }
    } while (cursor !== '0');
    return [...found];
  }

  /** All tenantIds that have a cart row in Postgres (used by the daily cleanup). */
  async getAllTenantIds(): Promise<string[]> {
    const rows = await this.db.db.selectDistinct({ tenantId: carts.tenantId }).from(carts);
    return rows.map((r) => r.tenantId);
  }
}
