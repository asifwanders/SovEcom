/**
 * The theme-name slug rule, declared locally.
 *
 * The single source of truth for this rule is `THEME_NAME_RE` in `@sovecom/theme-sdk`. The
 * compiled `dist/cli.js` binary must run under plain `node`, but the SDK ships source-first
 * so a runtime import from the binary cannot load it without a bundler. This drift-guarded local
 * copy is kept honest by a conformance test (`test/theme-name.conformance.test.ts`) that asserts
 * this regex's `.source` and `.flags` equal the SDK's.
 *
 * MUST stay byte-for-byte equal to `@sovecom/theme-sdk`'s `THEME_NAME_RE`.
 */
export const THEME_NAME_RE = /^[a-z][a-z0-9-]*$/;
