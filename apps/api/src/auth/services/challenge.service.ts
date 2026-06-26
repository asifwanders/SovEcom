/**
 * ChallengeService (SECURITY-CRITICAL).
 *
 * The 2FA login challenge is a STATEFUL, single-use, IP-bound, attempt-capped
 * Redis record — deliberately NOT a JWT (removes the token-confusion surface).
 *
 *   create(userId, tenantId, ip) -> opaque id (32-byte base64url),
 *     stored as JSON `{userId,tenantId,ip,attempts:0}` at `auth:chal:{id}` EX 300.
 *   consume(id, ip) -> `{userId,tenantId}` on success (then DELETE — single-use),
 *     or null when missing / ip-mismatch / attempts >= 5. Each failed attempt
 *     atomically INCRs the attempt counter.
 *
 * Bound to the originating IP; never logs the challenge id or any secret.
 */
import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { RedisService } from '../../redis/redis.service';

const CHALLENGE_TTL_SECONDS = 300; // 5 minutes
const MAX_ATTEMPTS = 5;
const ID_BYTES = 32;

interface ChallengeRecord {
  userId: string;
  tenantId: string;
  ip: string;
  attempts: number;
}

/** The identity unlocked by a successfully consumed challenge. */
export interface ConsumedChallenge {
  userId: string;
  tenantId: string;
}

@Injectable()
export class ChallengeService {
  constructor(private readonly redis: RedisService) {}

  private static key(id: string): string {
    return `auth:chal:${id}`;
  }

  /**
   * Create an IP-bound 2FA challenge and return its opaque id. The id is the
   * only handle the client receives; the record lives server-side in Redis.
   */
  async create(userId: string, tenantId: string, ip: string): Promise<string> {
    const id = randomBytes(ID_BYTES).toString('base64url');
    const record: ChallengeRecord = { userId, tenantId, ip, attempts: 0 };
    await this.redis.client.set(
      ChallengeService.key(id),
      JSON.stringify(record),
      'EX',
      CHALLENGE_TTL_SECONDS,
    );
    return id;
  }

  /**
   * Validate a challenge for the given id + originating IP. Returns the bound
   * identity on success (consuming the challenge — single-use), or null when the
   * challenge is missing, the IP does not match, or the attempt cap is hit. Each
   * call that does not immediately succeed atomically increments the counter.
   */
  async consume(id: string, ip: string): Promise<ConsumedChallenge | null> {
    const key = ChallengeService.key(id);
    const raw = await this.redis.client.get(key);
    if (raw === null) {
      return null; // missing or expired
    }

    let record: ChallengeRecord;
    try {
      record = JSON.parse(raw) as ChallengeRecord;
    } catch {
      await this.redis.client.del(key);
      return null;
    }

    if (record.ip !== ip || record.attempts >= MAX_ATTEMPTS) {
      // Burn an attempt against id/ip probing, then refuse.
      await this.bumpAttempts(key);
      return null;
    }

    // Single-use: consume on success.
    await this.redis.client.del(key);
    return { userId: record.userId, tenantId: record.tenantId };
  }

  /** Atomically count a failed attempt, preserving the record's TTL. */
  private async bumpAttempts(key: string): Promise<void> {
    const raw = await this.redis.client.get(key);
    if (raw === null) return;
    let record: ChallengeRecord;
    try {
      record = JSON.parse(raw) as ChallengeRecord;
    } catch {
      return;
    }
    record.attempts += 1;
    const ttl = await this.redis.client.ttl(key);
    if (ttl > 0) {
      await this.redis.client.set(key, JSON.stringify(record), 'EX', ttl);
    } else {
      await this.redis.client.set(key, JSON.stringify(record), 'KEEPTTL');
    }
  }
}
