/**
 * The module-name slug rule, declared locally.
 *
 * The single source of truth for this rule is `MODULE_NAME_RE` in `@sovecom/module-sdk`. The
 * compiled `dist/cli.js` is a binary that runs under plain `node`, but the SDK ships source-first
 * (`package.json#main` → `src/index.ts`, no dist), so a runtime import from the built binary would
 * resolve to raw TypeScript that node cannot load. This drift-guarded local copy is kept honest by
 * a conformance test (`test/module-name.conformance.test.ts`) that asserts this regex's `.source`
 * and `.flags` equal the SDK's.
 *
 * MUST stay byte-for-byte equal to `@sovecom/module-sdk`'s `MODULE_NAME_RE`.
 */
export const MODULE_NAME_RE = /^[a-z][a-z0-9-]*$/;
