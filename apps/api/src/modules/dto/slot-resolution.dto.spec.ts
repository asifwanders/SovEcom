/**
 * slot-resolution boundary validation.
 *
 * Pins that BOTH the `:slot` path param and the `module` body field are coerced to bounded
 * lowercase slugs at the boundary, rejecting anything else
 * with a 400 BadRequest before the service/DB are touched.
 */
import { BadRequestException } from '@nestjs/common';
import { parseSlotName, parseSlotResolution } from './slot-resolution.dto';

describe('parseSlotResolution (module body)', () => {
  it('accepts a lowercase module slug', () => {
    expect(parseSlotResolution('wishlist')).toBe('wishlist');
    expect(parseSlotResolution('my-module-2')).toBe('my-module-2');
  });

  it.each([
    ['uppercase', 'Wishlist'],
    ['empty', ''],
    ['leading digit', '2cool'],
    ['underscore', 'a_b'],
    ['non-string', 42],
    ['undefined', undefined],
    ['too long', 'a'.repeat(65)],
  ])('rejects %s → 400', (_label, value) => {
    expect(() => parseSlotResolution(value)).toThrow(BadRequestException);
  });
});

describe('parseSlotName (:slot path param)', () => {
  it('accepts a lowercase slot slug', () => {
    expect(parseSlotName('footer')).toBe('footer');
    expect(parseSlotName('product-detail-sidebar')).toBe('product-detail-sidebar');
  });

  it.each([
    ['uppercase', 'Footer'],
    ['empty', ''],
    ['path traversal', '../evil'],
    ['leading digit', '1slot'],
    ['non-string', {}],
    ['too long', 'a'.repeat(129)],
  ])('rejects %s → 400', (_label, value) => {
    expect(() => parseSlotName(value)).toThrow(BadRequestException);
  });
});
