import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

/** Reconnect backoff: 200ms, 400ms, … capped at 2s. Keeps retrying forever so the
 *  client recovers whenever Redis returns (the prior `() => null` never reconnected,
 *  leaving rate-limiting stuck in its fail-closed fallback for the process lifetime). */
const RECONNECT_BACKOFF_MS = (attempt: number): number => Math.min(attempt * 200, 2000);

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  readonly client: Redis;

  constructor() {
    this.client = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
      lazyConnect: true,
      // Per-COMMAND failure stays fast: with maxRetriesPerRequest:1 +
      // enableOfflineQueue:false a command issued while the link is down rejects
      // immediately, so RateLimitService fails CLOSED rather than hanging. The
      // CONNECTION, however, must auto-reconnect (backoff below) so the gate
      // recovers after a transient Redis blip instead of degrading permanently.
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: RECONNECT_BACKOFF_MS,
    });
    // Without a listener, ioredis 'error' events surface as noisy unhandled
    // rejections; log at warn and let the per-command catches (fail-closed) handle
    // the functional impact.
    this.client.on('error', (err: Error) => {
      this.logger.warn(`redis connection error: ${err.message}`);
    });
  }

  async ping(): Promise<boolean> {
    try {
      if (this.client.status !== 'ready' && this.client.status !== 'connecting') {
        await this.client.connect();
      }
      return (await this.client.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  onModuleDestroy(): void {
    this.client.disconnect();
  }
}

export { keys } from './keys';
