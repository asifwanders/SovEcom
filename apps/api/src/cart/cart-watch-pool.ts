/**
 * CartWatchPool (; concurrency-harness verification fix).
 *
 * `CartRepository.mutate()` needs a DEDICATED Redis connection per in-flight
 * optimistic transaction: WATCH/MULTI/EXEC isolation only holds if no other
 * fiber's commands interleave on the same socket between the WATCH and the EXEC.
 *
 * The first implementation created a fresh `client.duplicate()` + connect() per
 * mutation and `disconnect()`ed it in `finally`. Across a full suite that is
 * hundreds of connect/forcible-disconnect cycles, which intermittently crashed
 * Node with SIGSEGV (a forcible teardown racing ioredis' socket internals).
 *
 * This pool fixes the connection LIFECYCLE only — the WATCH/retry/idempotency
 * semantics in `mutate()` are unchanged. It keeps a small bounded set of reusable
 * dedicated connections:
 *  - `acquire()` hands out a free connection, or lazily creates+connects one if
 *    none is free (so two concurrent mutations always get DISTINCT connections).
 *  - `release()` UNWATCHes/resets the connection and returns it to the idle set —
 *    it is NOT disconnected, so the next mutation reuses the live socket.
 *  - Connections created beyond the cap are "transient overflow": used once, then
 *    closed gracefully with `quit()` (a clean FIN, never the forcible
 *    `disconnect()`), so the pool never grows unbounded under a spike.
 *  - `onModuleDestroy()` quits every pooled connection.
 *
 * Connections inherit the shared client's options (lazyConnect,
 * enableOfflineQueue:false), so each is connected before first use.
 */
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { RedisService } from '../redis/redis.service';

/** Max long-lived connections kept warm in the pool. Beyond this, mutations get a
 *  transient connection that is `quit()`-ed on release. 16 comfortably covers the
 *  race tests' bursts (≤ ~12 simultaneous mutations to one cart) with headroom. */
const POOL_CAP = 16;

/** Hard ceiling on TOTAL live connections (pooled + transient in-flight). Bounds
 *  the transient-overflow resource lever (S-4): beyond this, acquire() briefly waits
 *  for an idle connection rather than minting unbounded sockets. Generous vs POOL_CAP
 *  so only an adversarial spike ever reaches it. */
const MAX_TOTAL_CONNS = 64;
/** Max time acquire() waits for capacity before giving up with a conflict. */
const ACQUIRE_WAIT_MS = 2_000;

@Injectable()
export class CartWatchPool implements OnModuleDestroy {
  private readonly logger = new Logger(CartWatchPool.name);
  /** Idle, connected, reusable connections ready to hand out. */
  private readonly idle: Redis[] = [];
  /** Count of long-lived connections this pool owns (idle + checked-out, excluding
   *  transient overflow). Used to decide whether a new connection is poolable. */
  private owned = 0;
  /** Transient overflow connections currently checked out (quit() on release). */
  private transientInFlight = 0;
  private destroyed = false;

  constructor(private readonly redis: RedisService) {}

  /**
   * Check out a dedicated, connected connection. Reuses an idle one if available;
   * otherwise creates a new one. The returned `transient` flag tells `release()`
   * whether to keep the connection (pooled) or `quit()` it (overflow beyond cap).
   */
  async acquire(): Promise<{ conn: Redis; transient: boolean }> {
    const deadline = Date.now() + ACQUIRE_WAIT_MS;
    for (;;) {
      const pooled = this.idle.pop();
      if (pooled) {
        return { conn: pooled, transient: false };
      }
      // Bound total live connections — wait briefly for a release rather than
      // minting unbounded transient sockets under a spike (S-4).
      if (this.owned + this.transientInFlight >= MAX_TOTAL_CONNS) {
        if (Date.now() >= deadline) {
          throw new Error('CartWatchPool: no Redis connection available (capacity exhausted)');
        }
        await new Promise((r) => setTimeout(r, 5));
        continue;
      }

      const transient = this.owned >= POOL_CAP;
      const conn = this.redis.client.duplicate();
      try {
        if (conn.status !== 'ready' && conn.status !== 'connecting') {
          await conn.connect();
        }
      } catch (err) {
        // Never leak a connection that failed to connect.
        try {
          conn.disconnect(false);
        } catch {
          /* ignore */
        }
        throw err;
      }
      if (transient) {
        this.transientInFlight++;
      } else {
        this.owned++;
      }
      return { conn, transient };
    }
  }

  /**
   * Return a connection after a mutation. Always UNWATCHes first (so no watch is
   * ever left dangling on a reused socket). Pooled connections go back to the idle
   * set; transient-overflow connections are closed gracefully with `quit()`.
   */
  async release(conn: Redis, transient: boolean): Promise<void> {
    if (transient || this.destroyed) {
      if (transient) this.transientInFlight = Math.max(0, this.transientInFlight - 1);
      await this.quitQuietly(conn);
      return;
    }
    try {
      await conn.unwatch();
      this.idle.push(conn);
    } catch (err) {
      // A connection we can't reset is not safe to reuse — drop it from the pool
      // (decrement owned so a replacement can be created) and close it cleanly.
      this.owned = Math.max(0, this.owned - 1);
      this.logger.warn(
        `discarding a watch connection that failed to reset: ${err instanceof Error ? err.message : String(err)}`,
      );
      await this.quitQuietly(conn);
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.destroyed = true;
    const conns = this.idle.splice(0, this.idle.length);
    await Promise.all(conns.map((c) => this.quitQuietly(c)));
  }

  private async quitQuietly(conn: Redis): Promise<void> {
    try {
      await conn.quit();
    } catch {
      // Already closing / not connected — fall back to a non-forcible disconnect
      // without reconnect so we never leak the socket, but avoid the SIGSEGV-prone
      // forcible teardown of a mid-command connection.
      try {
        conn.disconnect(false);
      } catch {
        /* nothing more we can do */
      }
    }
  }
}
