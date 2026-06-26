import { describe, it, expect } from 'vitest';
import { MODULE_NAME_RE as SDK_MODULE_NAME_RE } from '@sovecom/module-sdk';
import { MODULE_NAME_RE as CLI_MODULE_NAME_RE } from '../src/module-name.js';

/**
 * Drift guard. The CLI carries its own copy of the module-name slug rule (`src/module-name.ts`)
 * because the built `dist/cli.js` binary must run under plain `node`, and the SDK ships source-first
 * so a runtime import from the binary cannot load it without a bundler. This test asserts the local
 * regex is identical to the SDK's (both `.source` and `.flags`). If the SDK changes the rule, this
 * test fails and forces the local copy to follow.
 *
 * NOTE: importing `@sovecom/module-sdk` here is fine — this test runs in the vitest/TS toolchain,
 * which resolves the SDK's source `main`. The whole point of the local copy is that the COMPILED
 * bin does not do this import.
 */
describe('module-name slug regex conformance with @sovecom/module-sdk', () => {
  it("matches the SDK's MODULE_NAME_RE.source", () => {
    expect(CLI_MODULE_NAME_RE.source).toBe(SDK_MODULE_NAME_RE.source);
  });

  it("matches the SDK's MODULE_NAME_RE.flags", () => {
    expect(CLI_MODULE_NAME_RE.flags).toBe(SDK_MODULE_NAME_RE.flags);
  });
});
