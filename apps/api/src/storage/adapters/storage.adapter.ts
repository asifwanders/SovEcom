/**
 * StorageAdapter interface + UploadResult shape.
 *
 * All adapters (local filesystem, S3/MinIO) implement this contract so
 * StorageService is driver-agnostic.
 */

export interface UploadResult {
  /** The storage key (path within the bucket/root). */
  key: string;
  /** Public URL to reach the object. */
  url: string;
  /** Object size in bytes. */
  size: number;
  /** MIME type passed at upload time. */
  contentType: string;
  /** ETag / MD5 hex digest of the content. */
  etag: string;
}

export interface StorageAdapter {
  /**
   * Store `content` at `key`. Returns metadata for the stored object.
   * Overwrites silently if the key already exists.
   */
  upload(key: string, content: Buffer, contentType: string): Promise<UploadResult>;

  /**
   * Retrieve the raw bytes for `key`.
   * @throws if the object does not exist.
   */
  download(key: string): Promise<Buffer>;

  /**
   * Remove the object at `key`. Idempotent — no error if already gone.
   */
  delete(key: string): Promise<void>;

  /**
   * Return `true` if the object exists, `false` otherwise.
   */
  exists(key: string): Promise<boolean>;

  /**
   * Return a permanent public URL for `key` (no auth required to read).
   */
  getPublicUrl(key: string): string;

  /**
   * Return a time-limited pre-signed URL for `key`.
   * @param expiresInSeconds - TTL for the signed URL.
   */
  getSignedUrl(key: string, expiresInSeconds: number): Promise<string>;
}
