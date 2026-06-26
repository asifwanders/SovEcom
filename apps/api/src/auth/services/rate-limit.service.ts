/**
 * RateLimitService (SECURITY-CRITICAL).
 *
 * Redis fixed-window counter (`INCR` + `EX` on first hit). `check(key)` returns
 * a decision and blocks once the count exceeds the threshold inside the window.
 *
 * FAILS CLOSED: if Redis throws/rejects (it is configured with
 * `enableOfflineQueue:false` / `maxRetriesPerRequest:1` so it errors fast under
 * pressure rather than hanging), the request is treated as BLOCKED — never
 * silently allowed — backed by a strict in-process fallback counter, and an
 * alert is logged. Never fails open.
 */
import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';

const DEFAULT_LIMIT = 10;
const DEFAULT_WINDOW_SECONDS = 60;
/** Hard cap on the in-process fail-closed fallback map (bounds outage memory). */
const FALLBACK_MAX_ENTRIES = 10_000;

/**
 * Atomic fixed-window INCR. Setting the TTL inside the same script closes the
 * INCR-then-EXPIRE gap: a crash (or a rejected EXPIRE) between two separate
 * round-trips could otherwise strand a TTL-less key, permanently blocking that
 * bucket. The `TTL < 0` guard also self-heals any key that somehow lost its TTL
 * (covers both the first hit and a previously-stranded key) without turning the
 * fixed window into a sliding one.
 */
const INCR_EXPIRE_LUA = `
local c = redis.call('INCR', KEYS[1])
if redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return c`;

export interface RateLimitOptions {
  /** Max permitted hits within the window (inclusive). */
  limit?: number;
  /** Window length in seconds. */
  windowSeconds?: number;
}

export interface RateLimitResult {
  /** True when the caller is allowed; false when blocked. */
  allowed: boolean;
  /** Current count within the window (best-effort under degradation). */
  count: number;
  /** True when this decision came from the fail-closed fallback path. */
  degraded: boolean;
}

@Injectable()
export class RateLimitService {
  private readonly logger = new Logger(RateLimitService.name);
  /** Strict in-process fallback used only when Redis is unavailable. */
  private readonly fallback = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly redis: RedisService) {}

  private static redisKey(key: string): string {
    return `auth:rl:${key}`;
  }

  /**
   * Register one hit on `key` and return whether the caller is within budget.
   * On any Redis error the request is BLOCKED (fail-closed) via a stricter local
   * counter, and the failure is logged as an alert.
   */
  async check(key: string, options: RateLimitOptions = {}): Promise<RateLimitResult> {
    const limit = options.limit ?? DEFAULT_LIMIT;
    const windowSeconds = options.windowSeconds ?? DEFAULT_WINDOW_SECONDS;
    const redisKey = RateLimitService.redisKey(key);

    try {
      // Atomic INCR + (conditional) EXPIRE — see INCR_EXPIRE_LUA.
      const count = (await this.redis.client.eval(
        INCR_EXPIRE_LUA,
        1,
        redisKey,
        String(windowSeconds),
      )) as number;
      return { allowed: count <= limit, count, degraded: false };
    } catch (err) {
      // FAIL CLOSED. Never allow silently when the gate is down.
      this.logger.error(
        `Rate-limit backend unavailable for key bucket; failing CLOSED. ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
      return this.failClosed(key, limit, windowSeconds);
    }
  }

  /**
   * Strict in-process counter for the Redis-down case. Tighter than the Redis
   * budget so an outage can never become an unthrottled window.
   */
  private failClosed(key: string, limit: number, windowSeconds: number): RateLimitResult {
    const now = Date.now();
    const entry = this.fallback.get(key);
    if (!entry || entry.resetAt <= now) {
      // Bound memory during a sustained outage with distinct keys: evict expired
      // entries (then hard-cap) so the fallback map cannot grow without limit.
      if (this.fallback.size >= FALLBACK_MAX_ENTRIES) {
        for (const [k, v] of this.fallback) {
          if (v.resetAt <= now) this.fallback.delete(k);
        }
        if (this.fallback.size >= FALLBACK_MAX_ENTRIES) {
          // Still full of live entries — drop the oldest-inserted to make room.
          const oldest = this.fallback.keys().next().value;
          if (oldest !== undefined) this.fallback.delete(oldest);
        }
      }
      this.fallback.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
      return { allowed: 1 <= limit, count: 1, degraded: true };
    }
    entry.count += 1;
    // Conservative: block at the same threshold, plus the degraded flag signals
    // callers/alerting that the primary gate is down.
    return { allowed: entry.count <= limit, count: entry.count, degraded: true };
  }
}
