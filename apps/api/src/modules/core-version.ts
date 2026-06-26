/**
 * The module-API contract version.
 *
 * The canonical constant now lives in `@sovecom/module-sdk` so the published author SDK
 * and the core runtime share ONE value. Re-exported here so the existing in-tree importers
 * (`module-manifest.ts`, the theme manifest) keep their import path.
 */
export { CORE_API_VERSION } from '@sovecom/module-sdk';
