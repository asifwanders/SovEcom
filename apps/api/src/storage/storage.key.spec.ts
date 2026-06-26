/**
 * Unit tests for buildKey + assertSafeKey (path-traversal defence).
 */
import { BadRequestException } from '@nestjs/common';
import { buildKey, assertSafeKey } from './storage.key';

describe('buildKey', () => {
  it('joins parts with forward slashes', () => {
    expect(
      buildKey({
        tenantId: 'tenant-1',
        resourceType: 'products',
        resourceId: 'prod-123',
        filename: 'image.jpg',
      }),
    ).toBe('tenant-1/products/prod-123/image.jpg');
  });

  it('produces a key that passes assertSafeKey', () => {
    const key = buildKey({
      tenantId: 'acme',
      resourceType: 'invoices',
      resourceId: 'inv-abc',
      filename: 'receipt.pdf',
    });
    expect(() => assertSafeKey(key)).not.toThrow();
  });
});

describe('assertSafeKey — valid keys', () => {
  const valid = [
    'tenant-1/products/prod-123/image.jpg',
    'acme/invoices/inv-abc/receipt.pdf',
    'a/b/c/d',
    'A1/B2/C3/file.tar.gz',
    'x/y/z/_.txt',
    'x/y/z/a-b_c.d',
    '_health/probe-123.txt',
  ];

  for (const key of valid) {
    it(`accepts "${key}"`, () => {
      expect(() => assertSafeKey(key)).not.toThrow();
    });
  }
});

describe('assertSafeKey — traversal / injection rejections', () => {
  const cases: Array<[string, string]> = [
    ['', 'empty string'],
    ['../etc/passwd', 'parent-dir traversal at start'],
    ['tenant/../../etc/passwd', 'parent-dir traversal in middle'],
    ['tenant/../secret', 'single parent-dir traversal'],
    ['/tenant/products/id/file.jpg', 'leading slash'],
    ['tenant/products/id/file.jpg/', 'trailing slash'],
    ['tenant\\products\\id\\file.jpg', 'backslashes'],
    ['tenant/products/id/file\x00.jpg', 'null byte'],
    ['tenant/products/id/file\x1f.jpg', 'control character'],
    ['tenant/products/id/file name.jpg', 'space in segment'],
    ['tenant/products/id/file!.jpg', 'bang in segment'],
    ['tenant/products/id/../../root', 'double traversal'],
    ['./relative', 'current-dir dot prefix'],
    ['tenant/products/id/fi<le>.jpg', 'angle brackets'],
  ];

  for (const [key, description] of cases) {
    it(`rejects "${description}"`, () => {
      expect(() => assertSafeKey(key)).toThrow(BadRequestException);
    });
  }
});

describe('Z5 dead-code: orphaned DTOs must not exist', () => {
  it('upload-result.dto.ts file must not be present', () => {
    expect(() => require('./dto/upload-result.dto')).toThrow();
  });
});
