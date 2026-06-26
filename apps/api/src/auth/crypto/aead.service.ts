/**
 * AeadService (SECURITY-CRITICAL).
 *
 * AES-256-GCM authenticated encryption for secrets at rest (the TOTP secret in
 * particular). The ciphertext is cryptographically bound to its owner via the
 * GCM additional-authenticated-data (AAD = userId): a blob encrypted for user A
 * cannot be decrypted under user B's id, so a swapped/copied row fails closed.
 *
 * Serialized form (base64):  iv(12) | authTag(16) | ciphertext.
 *
 * Key material: 32 bytes (256-bit) from the base64 `MASTER_KEY` env var, else
 * the raw bytes of `/data/master.key`. The key and any plaintext are NEVER
 * logged. A test/DI seam allows injecting the raw key directly.
 */
import { Injectable } from '@nestjs/common';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  type CipherGCM,
  type DecipherGCM,
} from 'node:crypto';
import { readFileSync } from 'node:fs';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // 96-bit nonce — the GCM standard
const TAG_BYTES = 16; // 128-bit auth tag
const DEFAULT_KEY_PATH = '/data/master.key';
/**
 * Known-default / weak `MASTER_KEY` env literals rejected in production (A3).
 * Mirrors TokenService's KNOWN_DEFAULT_SECRETS. The all-zero decoded key (a
 * common placeholder) is rejected separately by inspecting the key bytes.
 */
const KNOWN_DEFAULT_MASTER_KEYS = new Set(['changeme', 'secret', 'dev', 'masterkey']);

@Injectable()
export class AeadService {
  private readonly key: Buffer;

  /**
   * @param key Optional raw 32-byte key (test/DI seam). When omitted the key is
   *   loaded from `MASTER_KEY` (base64) or `/data/master.key`.
   */
  constructor(key?: Buffer) {
    const resolved = key ?? AeadService.loadKey();
    if (resolved.length !== KEY_BYTES) {
      throw new Error(`AeadService: master key must be ${KEY_BYTES} bytes, got ${resolved.length}`);
    }
    this.key = resolved;
  }

  /** Load the 32-byte key from `MASTER_KEY` (base64) or the master-key file. */
  private static loadKey(): Buffer {
    const fromEnv = process.env.MASTER_KEY;
    if (fromEnv && fromEnv.length > 0) {
      const decoded = Buffer.from(fromEnv, 'base64');
      AeadService.assertNotDefaultInProduction(fromEnv, decoded);
      return decoded;
    }
    const path = process.env.MASTER_KEY_PATH ?? DEFAULT_KEY_PATH;
    return readFileSync(path);
  }

  /**
   * In production reject a known-default / weak `MASTER_KEY` (A3): a known
   * literal, or an all-zero decoded key. Dev/test boot normally. Mirrors
   * TokenService.getSigningKey's KNOWN_DEFAULT_SECRETS approach.
   */
  private static assertNotDefaultInProduction(raw: string, decoded: Buffer): void {
    if (process.env.NODE_ENV !== 'production') {
      return;
    }
    if (KNOWN_DEFAULT_MASTER_KEYS.has(raw.toLowerCase())) {
      throw new Error('MASTER_KEY must not be a known default in production');
    }
    // An all-zero key is a common placeholder; it has the right length but no entropy.
    if (decoded.length === KEY_BYTES && decoded.every((b) => b === 0)) {
      throw new Error('MASTER_KEY must not be an all-zero default in production');
    }
  }

  /**
   * Encrypt `plaintext`, binding the ciphertext to `aad` (the owning userId).
   * A fresh random IV is generated per call.
   * @returns base64 of `iv | authTag | ciphertext`.
   */
  encrypt(plaintext: string, aad: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv) as CipherGCM;
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
  }

  /**
   * Decrypt a blob produced by {@link encrypt}, verifying BOTH the GCM tag and
   * the AAD (`aad` must equal the userId used at encryption time). Throws on any
   * tamper, wrong key, or wrong AAD — never returns garbage, never fails open.
   */
  decrypt(blob: string, aad: string): string {
    const raw = Buffer.from(blob, 'base64');
    if (raw.length < IV_BYTES + TAG_BYTES) {
      throw new Error('AeadService: ciphertext too short');
    }
    const iv = raw.subarray(0, IV_BYTES);
    const authTag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const ciphertext = raw.subarray(IV_BYTES + TAG_BYTES);

    const decipher = createDecipheriv(ALGORITHM, this.key, iv) as DecipherGCM;
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(authTag);
    // `final()` throws if the tag/AAD do not authenticate.
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString('utf8');
  }
}
