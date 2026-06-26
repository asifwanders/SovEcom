import { describe, it, expect } from 'vitest';
import { MODULE_PERMISSION_ALLOWLIST as SDK_ALLOWLIST } from '@sovecom/module-sdk';
import { MODULE_PERMISSION_ALLOWLIST } from '../src/index.js';

/**
 * Drift guard. This package re-uses the SDK's permission allowlist (single source of truth, ADR
 * 0059 §4) — it must NOT carry a divergent copy. The capability→permission map in `checks.ts` only
 * ever names strings that exist in the SDK allowlist; if the SDK adds/removes/renames a permission,
 * this test fails so the map is reviewed alongside it.
 */
describe('permission allowlist conformance with @sovecom/module-sdk', () => {
  it('re-exports the SDK allowlist verbatim (same members)', () => {
    expect([...MODULE_PERMISSION_ALLOWLIST].sort()).toEqual([...SDK_ALLOWLIST].sort());
  });
});
