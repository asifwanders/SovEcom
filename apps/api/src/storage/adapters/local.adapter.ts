/**
 * LocalAdapter: filesystem-backed StorageAdapter.
 *
 * Root directory: `LOCAL_STORAGE_PATH` env (default `/data/uploads`).
 * Public URL base: `PUBLIC_BASE_URL` env (default `http://localhost:3000`).
 * Signing secret: `STORAGE_SIGNING_SECRET` env (required for signed URLs).
 *
 * Signed URL format:
 *   <publicUrl>?expires=<epoch>&sig=<HMAC-SHA256(key|expires, secret)>
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { Injectable } from '@nestjs/common';
import { StorageAdapter, UploadResult } from './storage.adapter';
import { resolveStorageSigningSecret } from '../storage-signing-secret';

@Injectable()
export class LocalAdapter implements StorageAdapter {
  private readonly root: string;
  private readonly publicBase: string;
  private readonly signingSecret: string;

  constructor() {
    this.root = process.env['LOCAL_STORAGE_PATH'] ?? '/data/uploads';
    this.publicBase = process.env['PUBLIC_BASE_URL'] ?? 'http://localhost:3000';
    // validated once (production rejects unset/short/dev-default), mirroring JWT_SECRET.
    this.signingSecret = resolveStorageSigningSecret();
  }

  async upload(key: string, content: Buffer, contentType: string): Promise<UploadResult> {
    const dest = this.resolve(key);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);

    const etag = crypto.createHash('md5').update(content).digest('hex');
    return {
      key,
      url: this.getPublicUrl(key),
      size: content.length,
      contentType,
      etag,
    };
  }

  async download(key: string): Promise<Buffer> {
    const src = this.resolve(key);
    if (!fs.existsSync(src)) {
      throw new Error(`LocalAdapter: object not found: ${key}`);
    }
    return fs.readFileSync(src);
  }

  async delete(key: string): Promise<void> {
    const target = this.resolve(key);
    try {
      fs.unlinkSync(target);
    } catch (err: unknown) {
      // Idempotent — not-found is acceptable.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  async exists(key: string): Promise<boolean> {
    return fs.existsSync(this.resolve(key));
  }

  getPublicUrl(key: string): string {
    return `${this.publicBase}/uploads/${key}`;
  }

  async getSignedUrl(key: string, expiresInSeconds: number): Promise<string> {
    const expires = Math.floor(Date.now() / 1000) + expiresInSeconds;
    const sig = LocalAdapter.computeSig(key, expires, this.signingSecret);
    return `${this.getPublicUrl(key)}?expires=${expires}&sig=${sig}`;
  }

  /**
   * Verify a local signed URL signature + expiry.
   * Returns `true` when the signature is valid and the URL has not expired.
   */
  static verifySignature(key: string, expires: number, sig: string, secret: string): boolean {
    if (Date.now() / 1000 > expires) return false;
    const expected = LocalAdapter.computeSig(key, expires, secret);
    // Constant-time comparison to prevent timing attacks.
    if (expected.length !== sig.length) return false;
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
  }

  // ── private helpers ─────────────────────────────────────────────────────────

  private resolve(key: string): string {
    return path.join(this.root, key);
  }

  private static computeSig(key: string, expires: number, secret: string): string {
    return crypto.createHmac('sha256', secret).update(`${key}|${expires}`).digest('hex');
  }
}
