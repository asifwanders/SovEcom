/**
 * S3Adapter: AWS S3 / MinIO backed StorageAdapter.
 *
 * Env vars:
 *   S3_ENDPOINT          — custom endpoint (MinIO, LocalStack, etc.)
 *   S3_REGION            — default us-east-1
 *   S3_BUCKET            — bucket name (required)
 *   S3_ACCESS_KEY        — access key id
 *   S3_SECRET_KEY        — secret access key
 *   S3_FORCE_PATH_STYLE  — 'true' for MinIO (path-style addressing)
 *   S3_PUBLIC_BASE_URL   — override public base (else {endpoint}/{bucket})
 */
import { Readable } from 'stream';
import { Injectable } from '@nestjs/common';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  NotFound,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { StorageAdapter, UploadResult } from './storage.adapter';

@Injectable()
export class S3Adapter implements StorageAdapter {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly publicBase: string;

  constructor() {
    const endpoint = process.env['S3_ENDPOINT'];
    const region = process.env['S3_REGION'] ?? 'us-east-1';
    this.bucket = process.env['S3_BUCKET'] ?? '';
    const accessKeyId = process.env['S3_ACCESS_KEY'] ?? '';
    const secretAccessKey = process.env['S3_SECRET_KEY'] ?? '';
    const forcePathStyle = process.env['S3_FORCE_PATH_STYLE'] === 'true';

    this.client = new S3Client({
      region,
      ...(endpoint ? { endpoint } : {}),
      forcePathStyle,
      credentials: accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined,
    });

    const explicitBase = process.env['S3_PUBLIC_BASE_URL'];
    this.publicBase = explicitBase
      ? explicitBase
      : endpoint
        ? `${endpoint}/${this.bucket}`
        : `https://s3.${region}.amazonaws.com/${this.bucket}`;
  }

  async upload(key: string, content: Buffer, contentType: string): Promise<UploadResult> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: content,
        ContentType: contentType,
        ContentLength: content.length,
      }),
    );

    // HEAD to get ETag back (PutObject response ETag is also available but
    // occasionally absent for multi-part; HEAD is authoritative).
    const head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
    const rawEtag = head.ETag ?? '';
    const etag = rawEtag.replace(/"/g, '');

    return {
      key,
      url: this.getPublicUrl(key),
      size: content.length,
      contentType,
      etag,
    };
  }

  async download(key: string): Promise<Buffer> {
    const resp = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!resp.Body) throw new Error(`S3Adapter: empty body for key: ${key}`);
    return S3Adapter.streamToBuffer(resp.Body as Readable);
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (err: unknown) {
      if (S3Adapter.isNotFound(err)) return false;
      throw err;
    }
  }

  getPublicUrl(key: string): string {
    return `${this.publicBase}/${key}`;
  }

  async getSignedUrl(key: string, expiresInSeconds: number): Promise<string> {
    const cmd = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    return getSignedUrl(this.client, cmd, { expiresIn: expiresInSeconds });
  }

  // ── private helpers ─────────────────────────────────────────────────────────

  private static async streamToBuffer(stream: Readable): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  }

  private static isNotFound(err: unknown): boolean {
    if (err instanceof NotFound) return true;
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    return e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404;
  }
}
