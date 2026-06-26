/**
 * Tenant-isolated storage key helpers + path-traversal defence.
 *
 * Key layout: `{tenantId}/{resourceType}/{resourceId}/{filename}`
 *
 * Validation rules (assertSafeKey):
 *   - No empty string.
 *   - No `..` segments.
 *   - No leading or trailing `/`.
 *   - No backslashes.
 *   - No null bytes or control characters (< 0x20).
 *   - Every path segment must match `[A-Za-z0-9._-]+`.
 */
import { BadRequestException } from '@nestjs/common';

export interface KeyParts {
  tenantId: string;
  resourceType: string;
  resourceId: string;
  filename: string;
}

/** Assemble a canonical storage key from its constituent parts. */
export function buildKey({ tenantId, resourceType, resourceId, filename }: KeyParts): string {
  return [tenantId, resourceType, resourceId, filename].join('/');
}

/** Safe segment regex — allow alphanumeric, dot, dash, underscore only. */
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * Validate `key` against path-traversal and injection vectors.
 * Throws `BadRequestException` on any violation (NestJS 400).
 */
export function assertSafeKey(key: string): void {
  if (!key) {
    throw new BadRequestException('Storage key must not be empty');
  }

  // Null bytes / control characters (< 0x20).
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(key)) {
    throw new BadRequestException('Storage key contains control characters or null bytes');
  }

  // Backslashes (Windows-style traversal).
  if (key.includes('\\')) {
    throw new BadRequestException('Storage key must not contain backslashes');
  }

  // Leading or trailing slash.
  if (key.startsWith('/') || key.endsWith('/')) {
    throw new BadRequestException('Storage key must not start or end with /');
  }

  // Split into segments and validate each.
  const segments = key.split('/');
  for (const seg of segments) {
    if (seg === '..' || seg === '.') {
      throw new BadRequestException('Storage key must not contain "." or ".." traversal segments');
    }
    if (!SAFE_SEGMENT.test(seg)) {
      throw new BadRequestException(
        `Storage key segment "${seg}" contains invalid characters (allowed: A-Za-z0-9._-)`,
      );
    }
  }
}
