/**
 * the SINGLE place this package reaches the SDK's runtime
 * validators (`parseAndVerifyManifest`, `assertCoreCompatible`) and the permission allowlist.
 * These are REUSED, never re-declared — there is exactly one validator.
 *
 * The dual-context wrinkle: `@sovecom/module-sdk` ships
 * SOURCE-FIRST (`package.json#main` → `src/index.ts`, no bundler). In the TS/vitest toolchain a
 * bare `import '@sovecom/module-sdk'` resolves to that `.ts` source — fine. But the EMITTED
 * `dist/cli.js` runs under plain `node`, where the same bare specifier resolves to raw `.ts` node
 * cannot execute (exactly the ERR_MODULE_NOT_FOUND). No bundler is used to paper over it.
 *
 * So we load the SDK through `createRequire` against its COMPILED `dist/index.js` — valid CJS that
 * plain `node` (and vitest) can both `require` synchronously, present because the SDK emits CJS via
 * `tsc` and is built before this package runs (turbo `^build`; the package's own
 * `pretest`/`prebuild` build it too). This is the ONLY runtime contact with the SDK and yields the
 * REAL exported functions — no second, drifting copy of any contract rule is declared here.
 *
 * Why `createRequire(dist)` rather than a static `import '@sovecom/module-sdk'`: a static bare
 * import in the emitted `dist/cli.js` would resolve to the SDK's source-first `.ts` entry and crash
 * plain node at load time (the ERR_MODULE_NOT_FOUND). Loading the built CJS dist explicitly
 * is the one path that works identically in the TS/vitest toolchain AND in the plain-node bin.
 */
import { createRequire } from 'node:module';
import type {
  ModuleManifest,
  ModulePermission,
  parseAndVerifyManifest as ParseAndVerifyManifest,
  assertCoreCompatible as AssertCoreCompatible,
} from '@sovecom/module-sdk';

interface SdkSurface {
  parseAndVerifyManifest: typeof ParseAndVerifyManifest;
  assertCoreCompatible: typeof AssertCoreCompatible;
  MODULE_PERMISSION_ALLOWLIST: readonly ModulePermission[];
  CORE_API_VERSION: string;
}

const require = createRequire(import.meta.url);

function loadSdk(): SdkSurface {
  try {
    return require('@sovecom/module-sdk/dist/index.js') as SdkSurface;
  } catch (cause) {
    throw new Error(
      '@sovecom/module-contract-tests could not load @sovecom/module-sdk/dist/index.js. ' +
        'The SDK must be built first (CJS via tsc) — run `pnpm --filter @sovecom/module-sdk build` ' +
        'or `pnpm build` at the repo root.',
      { cause },
    );
  }
}

const sdk = loadSdk();

export const parseAndVerifyManifest = sdk.parseAndVerifyManifest;
export const assertCoreCompatible = sdk.assertCoreCompatible;
export const MODULE_PERMISSION_ALLOWLIST = sdk.MODULE_PERMISSION_ALLOWLIST;
export const CORE_API_VERSION = sdk.CORE_API_VERSION;

export type { ModuleManifest, ModulePermission };
