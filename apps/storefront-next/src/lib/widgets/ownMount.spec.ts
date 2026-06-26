import { describe, it, expect } from 'vitest';
import { isOwnMountPath, ownMountPrefix } from './ownMount';

/**
 * Own-mount enforcement. An interactive widget's POST-back path MUST target the ORIGINATING module's
 * own mount. The module name comes from the slot BINDING (never the descriptor). Validation ensures a
 * clean `/store/v1/modules/...` relative path with no traversal/encoding, and pins the `<name>` segment
 * to the binding's module.
 */
describe('ownMountPrefix', () => {
  it('builds the binding-module mount prefix', () => {
    expect(ownMountPrefix('wishlist')).toBe('/store/v1/modules/wishlist/');
  });
});

describe('isOwnMountPath', () => {
  it('accepts a path under the binding module own mount', () => {
    expect(isOwnMountPath('/store/v1/modules/wishlist/add', 'wishlist')).toBe(true);
    expect(isOwnMountPath('/store/v1/modules/wishlist/items/123', 'wishlist')).toBe(true);
  });

  it('REJECTS a path targeting a DIFFERENT module (the C1→C2 split)', () => {
    expect(isOwnMountPath('/store/v1/modules/evil/steal', 'wishlist')).toBe(false);
    expect(isOwnMountPath('/store/v1/modules/reviews/submit', 'wishlist')).toBe(false);
  });

  it('REJECTS a prefix-collision module name (wishlist vs wishlist-evil)', () => {
    // Must match the FULL `<name>/` segment — a longer name sharing the prefix is NOT the own mount.
    expect(isOwnMountPath('/store/v1/modules/wishlist-evil/x', 'wishlist')).toBe(false);
    expect(isOwnMountPath('/store/v1/modules/wishlistx/x', 'wishlist')).toBe(false);
  });

  it('REJECTS the bare mount with no trailing path', () => {
    // `/store/v1/modules/wishlist` (no trailing slash) is not a valid action target.
    expect(isOwnMountPath('/store/v1/modules/wishlist', 'wishlist')).toBe(false);
  });

  it('REJECTS a path not under the binding own mount (wrong origin/prefix/empty)', () => {
    // NB: `..` traversal + scheme/CRLF/encoding are C1 `parseWidget`'s job (rejected before C2 ever sees
    // the path). C2's `isOwnMountPath` is the additive binding-pin: it rejects anything not under the
    // exact `/store/v1/modules/<module>/` prefix (other origin, other endpoint, empty first segment).
    for (const bad of [
      'https://evil.example/store/v1/modules/wishlist/add',
      '//evil/store/v1/modules/wishlist/add',
      '/store/v1/carts/123/checkout',
      '',
      '/store/v1/modules//add',
    ]) {
      expect(isOwnMountPath(bad, 'wishlist')).toBe(false);
    }
  });
});
