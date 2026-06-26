import { describe, it, expect } from 'vitest';
import { SLOT_SLUG_RE as SDK_SLOT_SLUG_RE } from '@sovecom/theme-sdk';
import { SLOT_SLUG_RE } from '../src/index.js';

/**
 * Drift guard. This package re-uses the SDK's slot-slug rule (single source of truth)
 * — it must NOT carry a divergent copy. If the SDK ever changes the slot-slug shape, this test fails
 * so the contract-test suite is reviewed alongside it.
 */
describe('slot-slug rule conformance with @sovecom/theme-sdk', () => {
  it('re-exports the SDK slot-slug regex verbatim (same source)', () => {
    expect(SLOT_SLUG_RE.source).toBe(SDK_SLOT_SLUG_RE.source);
    expect(SLOT_SLUG_RE.flags).toBe(SDK_SLOT_SLUG_RE.flags);
  });
});
