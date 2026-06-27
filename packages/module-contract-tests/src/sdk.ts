/**
 * the SINGLE place this package reaches the SDK's runtime
 * validators (`parseAndVerifyManifest`, `assertCoreCompatible`) and the permission allowlist.
 * These are REUSED, never re-declared — there is exactly one validator.
 *
 * `@sovecom/module-sdk` ships DIST-FIRST: `package.json#main` and `exports["."]` both resolve to
 * the compiled `dist/index.js` (valid CJS emitted by `tsc`). We load it through `createRequire` so
 * the bare specifier resolves via Node — to that built CJS — identically under vitest AND under
 * plain `node` (the emitted `dist/cli.js` bin). The SDK is built before this package runs (turbo
 * `^build`; the package's own `pretest`/`prebuild` build it too). NOTE: require the bare
 * `@sovecom/module-sdk`, not `@sovecom/module-sdk/dist/index.js` — the SDK's strict `exports` map
 * exposes only `.`, so the explicit subpath is blocked (ERR_PACKAGE_PATH_NOT_EXPORTED). This is the
 * ONLY runtime contact with the SDK and yields the REAL exported validators — no drifting copy.
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
    return require('@sovecom/module-sdk') as SdkSurface;
  } catch (cause) {
    throw new Error(
      '@sovecom/module-contract-tests could not load @sovecom/module-sdk (its built CJS dist). ' +
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
