/**
 * the SINGLE place this package reaches the theme SDK's
 * runtime validators (`parseAndVerifyThemeManifest`, `assertCoreCompatible`) and the slot-slug rule
 * (`SLOT_SLUG_RE`). These are REUSED, never re-declared — there is exactly one
 * theme-manifest validator.
 *
 * The dual-context wrinkle: `@sovecom/theme-sdk` ships SOURCE-FIRST (`package.json#main` → `src/index.ts`, no bundler). In the
 * TS/vitest toolchain a bare `import '@sovecom/theme-sdk'` resolves to that `.ts` source — fine. But
 * the EMITTED `dist/cli.js` runs under plain `node`, where the same bare specifier resolves to raw
 * `.ts` node cannot execute (exactly the ERR_MODULE_NOT_FOUND). No bundler is used to paper over it.
 *
 * So we load the SDK through `createRequire` against its COMPILED `dist/index.js` — valid CJS that
 * plain `node` (and vitest) can both `require` synchronously, present because the SDK emits CJS via
 * `tsc` and is built before this package runs (turbo `^build`; the built-bin test also
 * builds it explicitly). This is the ONLY runtime contact with the SDK and yields the REAL exported
 * functions — no second, drifting copy of any contract rule is declared here.
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
    return require('@sovecom/theme-sdk/dist/index.js') as SdkSurface;
  } catch (cause) {
    throw new Error(
      '@sovecom/theme-contract-tests could not load @sovecom/theme-sdk/dist/index.js. ' +
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
