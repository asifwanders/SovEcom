/**
 * the SINGLE place this package reaches the theme SDK's
 * runtime validators (`parseAndVerifyThemeManifest`, `assertCoreCompatible`) and the slot-slug rule
 * (`SLOT_SLUG_RE`). These are REUSED, never re-declared — there is exactly one
 * theme-manifest validator.
 *
 * `@sovecom/theme-sdk` ships DIST-FIRST: `package.json#main` and `exports["."]` both resolve to the
 * compiled `dist/index.js` (valid CJS emitted by `tsc`). We load it through `createRequire` so the
 * bare specifier resolves via Node — to that built CJS — identically under vitest AND under plain
 * `node` (the emitted `dist/cli.js` bin). The SDK is built before this package runs (turbo `^build`;
 * the built-bin test also builds it explicitly). NOTE: require the bare `@sovecom/theme-sdk`, not
 * `@sovecom/theme-sdk/dist/index.js` — the SDK's strict `exports` map exposes only `.`, so the
 * explicit subpath is blocked (ERR_PACKAGE_PATH_NOT_EXPORTED). This is the ONLY runtime contact with
 * the SDK and yields the REAL exported validators — no drifting copy.
 */
import { createRequire } from 'node:module';
import type {
  ThemeManifest,
  parseAndVerifyThemeManifest as ParseAndVerifyThemeManifest,
  assertCoreCompatible as AssertCoreCompatible,
} from '@sovecom/theme-sdk';

interface SdkSurface {
  parseAndVerifyThemeManifest: typeof ParseAndVerifyThemeManifest;
  assertCoreCompatible: typeof AssertCoreCompatible;
  SLOT_SLUG_RE: RegExp;
  CORE_API_VERSION: string;
}

const require = createRequire(import.meta.url);

function loadSdk(): SdkSurface {
  try {
    return require('@sovecom/theme-sdk') as SdkSurface;
  } catch (cause) {
    throw new Error(
      '@sovecom/theme-contract-tests could not load @sovecom/theme-sdk (its built CJS dist). ' +
        'The SDK must be built first (CJS via tsc) — run `pnpm --filter @sovecom/theme-sdk build` ' +
        'or `pnpm build` at the repo root.',
      { cause },
    );
  }
}

const sdk = loadSdk();

export const parseAndVerifyThemeManifest = sdk.parseAndVerifyThemeManifest;
export const assertCoreCompatible = sdk.assertCoreCompatible;
export const SLOT_SLUG_RE = sdk.SLOT_SLUG_RE;
export const CORE_API_VERSION = sdk.CORE_API_VERSION;

export type { ThemeManifest };
