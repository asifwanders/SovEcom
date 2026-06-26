import { describe, it, expect } from 'vitest';
import { THEME_NAME_RE as SDK_THEME_NAME_RE } from '@sovecom/theme-sdk';
import { THEME_NAME_RE as CLI_THEME_NAME_RE } from '../src/theme-name.js';

/**
 * DRIFT GUARD. The CLI carries its OWN copy of the theme-name slug
 * rule (`src/theme-name.ts`) because the built `dist/cli.js` bin must run under plain `node`, and
 * the SDK ships source-first (`main` → `src/index.ts`) so a runtime import from the bin can't load
 * it without a bundler. To keep the SDK as the single source of truth,
 * this test asserts the local regex is byte-for-byte identical to the SDK's — BOTH `.source` and
 * `.flags`. If the SDK ever changes the rule, this test fails and forces the local copy to follow.
 *
 * NOTE: importing `@sovecom/theme-sdk` here is fine — this test runs in the vitest/TS toolchain,
 * which resolves the SDK's source `main`. The whole point of the local copy is that the COMPILED
 * bin does not do this import.
 */
describe('theme-name slug regex conformance with @sovecom/theme-sdk', () => {
  it("matches the SDK's THEME_NAME_RE.source", () => {
    expect(CLI_THEME_NAME_RE.source).toBe(SDK_THEME_NAME_RE.source);
  });

  it("matches the SDK's THEME_NAME_RE.flags", () => {
    expect(CLI_THEME_NAME_RE.flags).toBe(SDK_THEME_NAME_RE.flags);
  });
});
