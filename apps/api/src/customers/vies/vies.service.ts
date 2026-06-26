/**
 * ViesService — VAT validation.
 *
 * Orchestrates VAT validation over the injectable {@link ViesClient}:
 *   - Parses `VATNUMBER` into country (alpha-2) + the remaining digits.
 *   - Caches POSITIVE ('valid') results 24h in Redis for performance only.
 *     The cache is never the evidence of record (the durable `consultationRef`
 *     is persisted in `customers.metadata` by the caller).
 *   - Fails open on client error: a thrown client collapses to `unreachable`,
 *     so a VIES outage never blocks signup/update.
 *
 * Building the durable metadata proof and flipping `vat_validated` lives in
 * CustomersService (which owns the row); this service is the validation layer.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';
import { VIES_CLIENT, type ViesClient, type ViesCheckResult } from './vies.client';

const CACHE_TTL_SECONDS = 24 * 60 * 60; // 24h positive-result cache (perf only).
const CACHE_PREFIX = 'vies:valid:';

@Injectable()
export class ViesService {
  private readonly logger = new Logger(ViesService.name);

  constructor(
    @Inject(VIES_CLIENT) private readonly client: ViesClient,
    private readonly redis: RedisService,
  ) {}

  /**
   * Validate a full VAT number (e.g. `FR12345678901`). Returns the tri-state
   * result. Never throws. A malformed input or unparseable country → `invalid`
   * (the number cannot be a valid EU VAT number, so charge VAT permanently).
   */
  async validateVatNumber(rawVatNumber: string): Promise<ViesCheckResult> {
    const parsed = ViesService.parse(rawVatNumber);
    if (!parsed) {
      return { status: 'invalid' };
    }
    const { country, number } = parsed;

    // Positive-result cache (performance only — never the proof of record).
    // A cache hit must NOT fabricate a per-consultation `consultationRef`
    // for a different customer. Cache ONLY the validity (+ optional company/address)
    // and return a `cached:true` result with no consultationRef; the caller
    // persists a distinct cached-proof object.
    const cacheKey = `${CACHE_PREFIX}${country}${number}`;
    const cached = await this.readCache(cacheKey);
    if (cached) {
      return { ...cached, status: 'valid', cached: true };
    }

    let result: ViesCheckResult;
    try {
      result = await this.client.check(country, number);
    } catch (err) {
      // Fail OPEN: a transport error is `unreachable`, never a hard failure.
      this.logger.warn(
        `VIES client error for ${country}** — treating as unreachable: ${
          err instanceof Error ? err.message : 'unknown'
        }`,
      );
      result = { status: 'unreachable' };
    }

    if (result.status === 'valid') {
      // Cache validity only — strip the consultationRef (per-consultation
      // evidence must never be reused) and never cache the `cached` flag itself.
      await this.writeCache(cacheKey, {
        status: 'valid',
        companyName: result.companyName,
        address: result.address,
      });
    }
    return result;
  }

  /**
   * Split a VAT number into ISO-3166 alpha-2 country + the trailing identifier.
   * Strips spaces/dots; requires a 2-letter prefix and at least one trailing
   * alphanumeric. Returns null when it cannot be a well-formed VAT number.
   */
  static parse(raw: string): { country: string; number: string } | null {
    const cleaned = raw.replace(/[\s.]/g, '').toUpperCase();
    const m = /^([A-Z]{2})([0-9A-Z]+)$/.exec(cleaned);
    if (!m || !m[1] || !m[2]) {
      return null;
    }
    return { country: m[1], number: m[2] };
  }

  private async readCache(key: string): Promise<ViesCheckResult | null> {
    try {
      const raw = await this.redis.client.get(key);
      if (!raw) {
        return null;
      }
      return JSON.parse(raw) as ViesCheckResult;
    } catch {
      // Cache is best-effort; a Redis miss/error just means we re-check upstream.
      return null;
    }
  }

  private async writeCache(key: string, result: ViesCheckResult): Promise<void> {
    try {
      await this.redis.client.set(key, JSON.stringify(result), 'EX', CACHE_TTL_SECONDS);
    } catch {
      // Never let a cache write failure surface — validation already succeeded.
    }
  }
}
