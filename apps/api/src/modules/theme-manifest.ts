/**
 * Theme-manifest verification — re-exports from @sovecom/theme-sdk.
 *
 * The canonical schema, validator, type, and byte/slug rules live in the published SDK package,
 * ensuring authors, core runtime, and tests all consume one validator that cannot drift.
 * The shared core-API primitives (MANIFEST_MAX_BYTES, assertCoreCompatible, CORE_API_VERSION)
 * are defined once in @sovecom/module-sdk and surfaced through the theme SDK, so themes and
 * modules gate against the same core version.
 *
 * The validators remain pure — no Nest, no DB, no filesystem, no code execution.
 */
export {
  themeManifestSchema,
  parseAndVerifyThemeManifest,
  assertCoreCompatible,
} from '@sovecom/theme-sdk';

export type { ThemeManifest } from '@sovecom/theme-sdk';
