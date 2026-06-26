/**
 * StorageService: public API wrapping the injected StorageAdapter.
 *
 * Every entry-point validates the storage key before delegating to the adapter
 * so a caller cannot pass `../` or other traversal payloads.
 *
 * The `healthProbe()` method writes, reads, and deletes a synthetic object under
 * `_health/` and is wired into the aggregated /health endpoint.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { StorageAdapter, UploadResult } from './adapters/storage.adapter';
import { KeyParts, assertSafeKey, buildKey } from './storage.key';

/** DI token for the active StorageAdapter. */
export const STORAGE_ADAPTER = Symbol('STORAGE_ADAPTER');

export interface StorageHealthResult {
  ok: boolean;
  latencyMs: number;
}

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly adapter: StorageAdapter;

  constructor(@Inject(STORAGE_ADAPTER) adapter: object) {
    this.adapter = adapter as StorageAdapter;
  }

  /** Build and validate the key, then upload `content`. */
  async upload(parts: KeyParts, content: Buffer, contentType: string): Promise<UploadResult> {
    const key = buildKey(parts);
    assertSafeKey(key);
    return this.adapter.upload(key, content, contentType);
  }

  /** Validate `key`, then download the object bytes. */
  async download(key: string): Promise<Buffer> {
    assertSafeKey(key);
    return this.adapter.download(key);
  }

  /** Validate `key`, then delete the object (idempotent). */
  async delete(key: string): Promise<void> {
    assertSafeKey(key);
    return this.adapter.delete(key);
  }

  /** Validate `key`, then check existence. */
  async exists(key: string): Promise<boolean> {
    assertSafeKey(key);
    return this.adapter.exists(key);
  }

  /** Validate `key`, then return its public URL. */
  getPublicUrl(key: string): string {
    assertSafeKey(key);
    return this.adapter.getPublicUrl(key);
  }

  /** Validate `key`, then return a signed URL. */
  async getSignedUrl(key: string, expiresInSeconds: number): Promise<string> {
    assertSafeKey(key);
    return this.adapter.getSignedUrl(key, expiresInSeconds);
  }

  /**
   * Liveness/readiness probe: upload a small object, read it back, delete it.
   * Reports `ok:false` instead of throwing so the health check can degrade
   * gracefully rather than crash the endpoint.
   */
  async healthProbe(): Promise<StorageHealthResult> {
    const probeKey = `_health/probe-${Date.now()}.txt`;
    const content = Buffer.from('ping');
    const t0 = Date.now();
    try {
      await this.adapter.upload(probeKey, content, 'text/plain');
      const data = await this.adapter.download(probeKey);
      await this.adapter.delete(probeKey);
      if (!data.equals(content)) throw new Error('probe content mismatch');
      return { ok: true, latencyMs: Date.now() - t0 };
    } catch (err) {
      this.logger.warn('Storage health probe failed', err);
      return { ok: false, latencyMs: Date.now() - t0 };
    }
  }
}
