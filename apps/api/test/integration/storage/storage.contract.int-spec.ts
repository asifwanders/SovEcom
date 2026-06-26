/**
 * Contract integration tests for StorageAdapter.
 *
 * The SAME contract suite is exercised against BOTH adapters:
 *   1. LocalAdapter — using a tmp directory under os.tmpdir()
 *   2. S3Adapter    — using a local MinIO instance (localhost:9000)
 *
 * MinIO env: S3_ENDPOINT=http://localhost:9000, S3_BUCKET=sovecom-test,
 *            S3_ACCESS_KEY=minioadmin, S3_SECRET_KEY=minioadmin,
 *            S3_FORCE_PATH_STYLE=true, S3_REGION=us-east-1.
 *
 * The bucket is created in beforeAll (CreateBucketCommand) — already-exists
 * errors are silently ignored.
 */
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as https from 'https';
import * as crypto from 'crypto';
import { URL } from 'url';
import { S3Client, CreateBucketCommand, BucketAlreadyOwnedByYou } from '@aws-sdk/client-s3';

import { LocalAdapter } from '../../../src/storage/adapters/local.adapter';
import { S3Adapter } from '../../../src/storage/adapters/s3.adapter';
import { StorageAdapter } from '../../../src/storage/adapters/storage.adapter';

// ── helpers ──────────────────────────────────────────────────────────────────

function randomKey(prefix = 'tenant-test'): string {
  return `${prefix}/files/res-${Date.now()}-${Math.random().toString(36).slice(2)}/test.bin`;
}

/** Fetch a URL and return { status, body }. */
function fetchUrl(rawUrl: string): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(rawUrl);
    const lib = parsed.protocol === 'https:' ? https : http;
    lib
      .get(rawUrl, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
      })
      .on('error', reject);
  });
}

// ── contract suite factory ────────────────────────────────────────────────────

function contractSuite(
  label: string,
  getAdapter: () => StorageAdapter,
  extraSetup?: () => Promise<void>,
) {
  describe(`StorageAdapter contract — ${label}`, () => {
    let adapter: StorageAdapter;

    beforeAll(async () => {
      if (extraSetup) await extraSetup();
      adapter = getAdapter();
    });

    // ── upload / exists / download / delete lifecycle ─────────────────────────

    it('upload → exists(true) → download(bytes match) → delete → exists(false)', async () => {
      const key = randomKey();
      const content = Buffer.from('hello contract test');
      const contentType = 'text/plain';

      // Upload
      const result = await adapter.upload(key, content, contentType);
      expect(result.key).toBe(key);
      expect(result.size).toBe(content.length);
      expect(result.contentType).toBe(contentType);
      expect(typeof result.etag).toBe('string');
      expect(result.etag.length).toBeGreaterThan(0);
      expect(result.url).toContain(key);

      // Exists → true
      expect(await adapter.exists(key)).toBe(true);

      // Download → bytes match
      const downloaded = await adapter.download(key);
      expect(downloaded).toEqual(content);

      // Delete
      await adapter.delete(key);

      // Exists → false
      expect(await adapter.exists(key)).toBe(false);
    });

    it('exists returns false for a non-existent key', async () => {
      expect(await adapter.exists('tenant-ghost/files/res-0/never.bin')).toBe(false);
    });

    it('delete is idempotent (no error for missing key)', async () => {
      await expect(adapter.delete('tenant-ghost/files/res-0/never.bin')).resolves.not.toThrow();
    });

    it('download throws for a missing key', async () => {
      await expect(adapter.download('tenant-ghost/files/res-0/never.bin')).rejects.toThrow();
    });

    // ── getPublicUrl ──────────────────────────────────────────────────────────

    it('getPublicUrl returns a non-empty string containing the key', () => {
      const key = randomKey();
      const url = adapter.getPublicUrl(key);
      expect(typeof url).toBe('string');
      expect(url.length).toBeGreaterThan(0);
      expect(url).toContain(key);
    });

    // ── getSignedUrl ──────────────────────────────────────────────────────────

    it('getSignedUrl returns a non-empty string', async () => {
      const key = randomKey();
      const content = Buffer.from('signed-url-test');
      await adapter.upload(key, content, 'text/plain');

      const signed = await adapter.getSignedUrl(key, 300);
      expect(typeof signed).toBe('string');
      expect(signed.length).toBeGreaterThan(0);

      await adapter.delete(key);
    });

    // ── large file round-trip ─────────────────────────────────────────────────

    it('large file (10 MB) round-trips correctly', async () => {
      const key = randomKey('tenant-large');
      const content = Buffer.alloc(10 * 1024 * 1024, 0xab); // 10 MB, all 0xAB

      const result = await adapter.upload(key, content, 'application/octet-stream');
      expect(result.size).toBe(content.length);

      const downloaded = await adapter.download(key);
      expect(downloaded.length).toBe(content.length);
      expect(downloaded.equals(content)).toBe(true);

      await adapter.delete(key);
    }, 60_000);

    // ── tenant isolation ──────────────────────────────────────────────────────

    it('tenant-prefixed keys are stored and retrieved independently', async () => {
      const keyA = `tenant-A/products/prod-1/img.jpg`;
      const keyB = `tenant-B/products/prod-1/img.jpg`;
      const contentA = Buffer.from('tenant-A-data');
      const contentB = Buffer.from('tenant-B-data');

      await adapter.upload(keyA, contentA, 'image/jpeg');
      await adapter.upload(keyB, contentB, 'image/jpeg');

      expect(await adapter.download(keyA)).toEqual(contentA);
      expect(await adapter.download(keyB)).toEqual(contentB);

      await adapter.delete(keyA);
      await adapter.delete(keyB);
    });
  });
}

// ── Local adapter setup ───────────────────────────────────────────────────────

let localTmpDir: string;
let localAdapter: LocalAdapter;

const originalLocalPath = process.env['LOCAL_STORAGE_PATH'];

contractSuite(
  'LocalAdapter',
  () => localAdapter,
  async () => {
    localTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sovecom-storage-test-'));
    process.env['LOCAL_STORAGE_PATH'] = localTmpDir;
    process.env['STORAGE_SIGNING_SECRET'] = 'test-signing-secret';
    localAdapter = new LocalAdapter();
  },
);

afterAll(() => {
  // Restore env and clean tmp dir.
  if (originalLocalPath !== undefined) {
    process.env['LOCAL_STORAGE_PATH'] = originalLocalPath;
  } else {
    delete process.env['LOCAL_STORAGE_PATH'];
  }
  if (localTmpDir && fs.existsSync(localTmpDir)) {
    fs.rmSync(localTmpDir, { recursive: true, force: true });
  }
});

// ── S3 (MinIO) adapter setup ──────────────────────────────────────────────────

const MINIO_ENDPOINT = process.env['S3_ENDPOINT'] ?? 'http://localhost:9000';
const MINIO_BUCKET = process.env['S3_BUCKET'] ?? 'sovecom-test';
const MINIO_ACCESS_KEY = process.env['S3_ACCESS_KEY'] ?? 'minioadmin';
const MINIO_SECRET_KEY = process.env['S3_SECRET_KEY'] ?? 'minioadmin';

let s3Adapter: S3Adapter;

contractSuite(
  'S3Adapter (MinIO)',
  () => s3Adapter,
  async () => {
    // Ensure env is set so S3Adapter constructor picks them up.
    process.env['S3_ENDPOINT'] = MINIO_ENDPOINT;
    process.env['S3_BUCKET'] = MINIO_BUCKET;
    process.env['S3_ACCESS_KEY'] = MINIO_ACCESS_KEY;
    process.env['S3_SECRET_KEY'] = MINIO_SECRET_KEY;
    process.env['S3_FORCE_PATH_STYLE'] = 'true';
    process.env['S3_REGION'] = 'us-east-1';

    // Create the bucket (idempotent — ignore BucketAlreadyOwnedByYou).
    const s3 = new S3Client({
      region: 'us-east-1',
      endpoint: MINIO_ENDPOINT,
      forcePathStyle: true,
      credentials: {
        accessKeyId: MINIO_ACCESS_KEY,
        secretAccessKey: MINIO_SECRET_KEY,
      },
    });
    try {
      await s3.send(new CreateBucketCommand({ Bucket: MINIO_BUCKET }));
    } catch (err: unknown) {
      const name = (err as { name?: string }).name ?? '';
      // MinIO returns BucketAlreadyOwnedByYou when the bucket already exists.
      if (
        !(err instanceof BucketAlreadyOwnedByYou) &&
        name !== 'BucketAlreadyOwnedByYou' &&
        name !== 'BucketAlreadyExists'
      ) {
        throw err;
      }
    }

    s3Adapter = new S3Adapter();
  },
);

// ── S3 signed URL actual GET test ─────────────────────────────────────────────
describe('S3Adapter — signed URL resolves to the correct object', () => {
  it('GET on signed URL returns 200 with the uploaded bytes', async () => {
    process.env['S3_ENDPOINT'] = MINIO_ENDPOINT;
    process.env['S3_BUCKET'] = MINIO_BUCKET;
    process.env['S3_ACCESS_KEY'] = MINIO_ACCESS_KEY;
    process.env['S3_SECRET_KEY'] = MINIO_SECRET_KEY;
    process.env['S3_FORCE_PATH_STYLE'] = 'true';
    process.env['S3_REGION'] = 'us-east-1';

    const adapter = new S3Adapter();
    const key = randomKey('tenant-signed');
    const content = Buffer.from('signed-url-content');
    await adapter.upload(key, content, 'text/plain');

    const signed = await adapter.getSignedUrl(key, 300);
    const { status, body } = await fetchUrl(signed);

    expect(status).toBe(200);
    expect(body).toEqual(content);

    await adapter.delete(key);
  }, 30_000);
});

// ── Local signed URL verification ────────────────────────────────────────────
describe('LocalAdapter — signature verification', () => {
  it('valid signature passes', () => {
    const expires = Math.floor(Date.now() / 1000) + 300;
    const secret = 'test-secret';
    const key = 'tenant-1/products/prod-1/img.jpg';
    // Compute expected sig the same way LocalAdapter does internally.
    const sig = crypto.createHmac('sha256', secret).update(`${key}|${expires}`).digest('hex');
    expect(LocalAdapter.verifySignature(key, expires, sig, secret)).toBe(true);
  });

  it('expired signature fails', () => {
    const expires = Math.floor(Date.now() / 1000) - 10; // 10 s in the past
    const secret = 'test-secret';
    const key = 'tenant-1/products/prod-1/img.jpg';
    const sig = crypto.createHmac('sha256', secret).update(`${key}|${expires}`).digest('hex');
    expect(LocalAdapter.verifySignature(key, expires, sig, secret)).toBe(false);
  });

  it('tampered signature fails', () => {
    const expires = Math.floor(Date.now() / 1000) + 300;
    const secret = 'test-secret';
    const key = 'tenant-1/products/prod-1/img.jpg';
    const sig = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    expect(LocalAdapter.verifySignature(key, expires, sig, secret)).toBe(false);
  });
});
